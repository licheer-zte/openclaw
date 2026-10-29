// Regression for #187359: a gateway-mode send that outlives the caller's RPC
// deadline is reattached with its original idempotency key so the live Gateway
// joins the in-flight send, instead of surfacing a timeout that makes the agent
// retry into a duplicate platform delivery.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { resolveAgentIdFromSessionKeyForTests } from "../../gateway/server-methods/send.test-helpers.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import type {
  OutboundGatewayRequest,
  OutboundMessageGatewayOptionsInput,
} from "./message-gateway-options.js";

const TEST_AGENT_WORKSPACE = "/tmp/openclaw-test-workspace";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  resolveOutboundSessionRoute: vi.fn(),
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => ({}),
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveSessionAgentId: ({
    sessionKey,
    agentId,
  }: {
    sessionKey?: string;
    config?: unknown;
    agentId?: string;
  }) => resolveAgentIdFromSessionKeyForTests({ sessionKey, agentId }),
  resolveAgentConfig: () => undefined,
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => TEST_AGENT_WORKSPACE,
}));

vi.mock("./deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("./outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
  ensureOutboundSessionEntry: mocks.ensureOutboundSessionEntry,
}));

let sendMessage: typeof import("./message.js").sendMessage;
let dispatchGatewayRequestInProcess: typeof import("../../gateway/server-in-process-dispatch.js").dispatchGatewayRequestInProcess;
let sendHandlers: typeof import("../../gateway/server-methods/send.js").sendHandlers;

beforeAll(async () => {
  ({ sendMessage } = await import("./message.js"));
  ({ dispatchGatewayRequestInProcess } =
    await import("../../gateway/server-in-process-dispatch.js"));
  ({ sendHandlers } = await import("../../gateway/server-methods/send.js"));
});

/** Wires sendMessage to the real in-process dispatcher and the real send handler. */
function createInProcessSendGateway() {
  const sendHandler = sendHandlers.send;
  if (!sendHandler) {
    throw new Error("send handler missing");
  }
  const methodRegistry = createGatewayMethodRegistry([
    {
      name: "send",
      owner: { kind: "core", area: "message" },
      scope: "operator.write",
      handler: sendHandler,
    },
  ]);
  const context = {
    dedupe: new Map(),
    getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
    getGatewayMethodRegistry: () => methodRegistry,
    trackExecution: <T>(run: () => Promise<T>) => run(),
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
  } as unknown as GatewayRequestContext;
  const request = async <T>(rpc: OutboundGatewayRequest): Promise<T> =>
    await dispatchGatewayRequestInProcess<T>(rpc.method, rpc.params ?? {}, {
      client: null,
      context,
      methodRegistry,
      ...(rpc.timeoutMs != null ? { timeoutMs: rpc.timeoutMs } : {}),
      ...(rpc.signal ? { signal: rpc.signal } : {}),
    });
  return { context, request };
}

function sendSlowChannelMessage(
  request: NonNullable<OutboundMessageGatewayOptionsInput["request"]>,
  params: { idempotencyKey: string },
) {
  return sendMessage({
    cfg: {},
    to: "channel:C1",
    channel: "slowchat",
    content: "photo from the site",
    mediaUrl: "file:///tmp/workspace/photo.png",
    idempotencyKey: params.idempotencyKey,
    gateway: {
      request,
      timeoutMs: 50,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    },
  }).then(
    (result) => ({ status: "resolved" as const, result }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

describe("sendMessage gateway send timeout reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureOutboundSessionEntry.mockResolvedValue(undefined);
    mocks.resolveOutboundTarget.mockResolvedValue({ ok: true, to: "resolved" });
    mocks.resolveOutboundSessionRoute.mockResolvedValue({
      sessionKey: "agent:main:slowchat:resolved",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slowchat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "slowchat" }),
            outbound: { deliveryMode: "gateway" },
          },
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("reattaches a send that outlives the caller deadline and returns the original delivery", async () => {
    const { request } = createInProcessSendGateway();
    const deliveryStarted = createDeferred();
    const finishDelivery = createDeferred();
    mocks.deliverOutboundPayloads.mockImplementation(async () => {
      deliveryStarted.resolve();
      await finishDelivery.promise;
      return [{ channel: "slowchat", messageId: "m-slow-media" }];
    });

    let settledEarly = false;
    const outcome = sendSlowChannelMessage(request, { idempotencyKey: "idem-slow-media-send" });
    void outcome.then(() => {
      settledEarly = true;
    });

    try {
      await deliveryStarted.promise;
      // The caller deadline expires while the platform upload keeps running.
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      expect(settledEarly).toBe(false);
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      finishDelivery.resolve();
      const settled = await outcome;
      expect(settled.status).toBe("resolved");
      if (settled.status === "resolved") {
        expect(settled.result.via).toBe("gateway");
        expect(settled.result.result).toMatchObject({
          messageId: "m-slow-media",
          runId: "idem-slow-media-send",
        });
      }
      // The timed-out attempt was joined, not retried: exactly one platform delivery.
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    } finally {
      finishDelivery.resolve();
      await outcome;
    }
  });

  it("does not reattach a send that fails with a definitive provider error", async () => {
    const { request } = createInProcessSendGateway();
    mocks.deliverOutboundPayloads.mockRejectedValue(new Error("provider rejected the upload"));

    const settled = await sendSlowChannelMessage(request, { idempotencyKey: "idem-failing-send" });

    expect(settled.status).toBe("rejected");
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });
});
