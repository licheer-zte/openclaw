// Regression for issue #171022: Doctor's auth-profile migration cloned config through
// structuredClone, dropping the loader's WeakMap-keyed env-resolution facts, so resolved
// `${ENV}` SecretRef shorthand was re-classified as a plaintext secret by the security audit.
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveConfigForRead } from "../../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { collectSecurityWarnings } from "../doctor-security.js";
import { repairAuthProfileMigration } from "./auth-profile-repair.js";

const prompter = { shouldRepair: false, confirmAutoFix: async () => false };

function loadConfigWithEnvFacts(raw: object, env: Record<string, string>): OpenClawConfig {
  const resolution = resolveConfigForRead(raw, env);
  const cfg = resolution.resolvedConfigRaw as OpenClawConfig;
  setConfigResolutionFacts(cfg, resolution.resolutionFacts);
  return cfg;
}

async function withIsolatedState<T>(run: () => Promise<T>): Promise<T> {
  return withTestDir({ prefix: "openclaw-doctor-env-facts-" }, async (home) => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
    await closeOpenClawStateDatabaseAsync();
    try {
      return await run();
    } finally {
      await closeOpenClawStateDatabaseAsync();
      vi.unstubAllEnvs();
    }
  });
}

it("keeps resolved ${ENV} botToken shorthand off the plaintext-secrets warning after auth migration", async () => {
  await withIsolatedState(async () => {
    const env = {
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
      TELEGRAM_BOT_TOKEN_FAKE_A: "dummy-telegram-token-a",
      TELEGRAM_BOT_TOKEN_FAKE_B: "dummy-telegram-token-b",
    };
    const cfg = loadConfigWithEnvFacts(
      {
        channels: {
          telegram: {
            enabled: true,
            accounts: {
              default: { botToken: "${TELEGRAM_BOT_TOKEN_FAKE_A}", dmPolicy: "pairing" },
              second: { botToken: "${TELEGRAM_BOT_TOKEN_FAKE_B}", dmPolicy: "pairing" },
            },
          },
        },
      },
      env,
    );

    const beforeMigration = await collectSecurityWarnings(cfg, env);
    expect(
      beforeMigration.filter((finding) => finding.checkId === "config.plaintext_secrets"),
    ).toEqual([]);

    const repaired = await repairAuthProfileMigration({ cfg, env, prompter });

    const afterMigration = await collectSecurityWarnings(repaired.config, env);
    expect(
      afterMigration.filter((finding) => finding.checkId === "config.plaintext_secrets"),
    ).toEqual([]);
  });
});

it("still warns for literal plaintext bot tokens after auth migration", async () => {
  await withIsolatedState(async () => {
    const env = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
    const cfg = loadConfigWithEnvFacts(
      {
        channels: {
          telegram: {
            enabled: true,
            accounts: {
              default: { botToken: "literal-dummy-telegram-token", dmPolicy: "pairing" },
            },
          },
        },
      },
      env,
    );

    const repaired = await repairAuthProfileMigration({ cfg, env, prompter });

    const findings = await collectSecurityWarnings(repaired.config, env);
    const plaintext = findings.filter((finding) => finding.checkId === "config.plaintext_secrets");
    expect(plaintext).toHaveLength(1);
    expect(plaintext[0]?.remediation).toContain("channels.telegram.accounts.default.botToken");
  });
});
