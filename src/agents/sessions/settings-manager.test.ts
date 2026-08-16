/** Tests session settings loading, persistence, and runtime overrides. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileSettingsStorage,
  SettingsManager,
  type SettingsScope,
  type SettingsStorage,
} from "./settings-manager.js";

class InspectableSettingsStorage implements SettingsStorage {
  private values: Record<SettingsScope, string | undefined> = {
    global: undefined,
    project: undefined,
  };

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    const next = fn(this.values[scope]);
    if (next !== undefined) {
      this.values[scope] = next;
    }
  }

  set(scope: SettingsScope, value: unknown): void {
    this.values[scope] = typeof value === "string" ? value : JSON.stringify(value);
  }

  get(scope: SettingsScope): unknown {
    const value = this.values[scope];
    return value === undefined ? undefined : JSON.parse(value);
  }
}

describe("SettingsManager scoped persistence", () => {
  it("preserves external sibling changes while writing global and project scopes", async () => {
    const storage = new InspectableSettingsStorage();
    storage.set("global", {
      terminal: { showImages: true, imageWidthCells: 60 },
      packages: ["npm:@openclaw/global"],
    });
    storage.set("project", {
      packages: ["npm:@openclaw/project"],
      skills: ["old-skill"],
    });
    const settingsManager = SettingsManager.fromStorage(storage);

    const updatedSkills = ["new-skill"];
    settingsManager.setShowImages(false);
    settingsManager.setProjectSkillPaths(updatedSkills);
    updatedSkills.push("caller-mutation");
    storage.set("global", {
      terminal: { showImages: true, imageWidthCells: 120, clearOnShrink: true },
      packages: ["npm:@openclaw/global"],
    });
    storage.set("project", {
      packages: ["npm:@openclaw/external"],
      skills: ["old-skill"],
      themes: ["external-theme"],
    });

    await settingsManager.flush();

    expect(storage.get("global")).toEqual({
      terminal: { showImages: false, imageWidthCells: 120, clearOnShrink: true },
      packages: ["npm:@openclaw/global"],
    });
    expect(storage.get("project")).toEqual({
      packages: ["npm:@openclaw/external"],
      skills: ["new-skill"],
      themes: ["external-theme"],
    });

    await settingsManager.reload();
    expect(settingsManager.getShowImages()).toBe(false);
    expect(settingsManager.getImageWidthCells()).toBe(120);
    expect(settingsManager.getClearOnShrink()).toBe(true);
    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/external"]);
    expect(settingsManager.getSkillPaths()).toEqual(["new-skill"]);
    expect(settingsManager.getThemePaths()).toEqual(["external-theme"]);
  });

  it("isolates parse failures to the affected scope", async () => {
    const storage = new InspectableSettingsStorage();
    storage.set("global", "{");
    storage.set("project", { skills: ["old-skill"] });
    const settingsManager = SettingsManager.fromStorage(storage);

    expect(settingsManager.drainErrors()).toEqual([
      expect.objectContaining({ scope: "global", error: expect.any(SyntaxError) }),
    ]);
    settingsManager.setTheme("blocked-global-write");
    settingsManager.setProjectSkillPaths(["new-skill"]);
    await settingsManager.flush();

    expect(() => storage.get("global")).toThrow(SyntaxError);
    expect(storage.get("project")).toEqual({ skills: ["new-skill"] });
  });
});

describe("SettingsManager runtime overrides", () => {
  it("preserves compaction overrides after global setting writes", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    });

    settingsManager.applyOverrides({
      compaction: { reserveTokens: 50_000, keepRecentTokens: 16_000 },
    });
    settingsManager.setCompactionEnabled(false);

    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 16_000,
    });

    await settingsManager.flush();
    await settingsManager.reload();

    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 16_000,
    });
  });

  it("preserves runtime overrides after project setting writes", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { reserveTokens: 16_384 },
    });

    settingsManager.applyOverrides({ compaction: { reserveTokens: 50_000 } });
    settingsManager.setProjectPackages(["npm:@openclaw/example"]);

    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/example"]);
    expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);

    await settingsManager.flush();
    await settingsManager.reload();

    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/example"]);
    expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);
  });

  it("recursively merges provider retry overrides and replaces arrays", () => {
    const settingsManager = SettingsManager.inMemory({
      retry: {
        provider: { timeoutMs: 30_000, maxRetries: 2, maxRetryDelayMs: 60_000 },
      },
      packages: ["npm:@openclaw/base"],
    });

    settingsManager.applyOverrides({
      retry: { provider: { maxRetries: 5 } },
      packages: ["npm:@openclaw/override"],
    });

    expect(settingsManager.getProviderRetrySettings()).toEqual({
      timeoutMs: 30_000,
      maxRetries: 5,
      maxRetryDelayMs: 60_000,
    });
    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/override"]);
  });
});

describe("FileSettingsStorage first-write atomicity", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStorage(): { storage: FileSettingsStorage; settingsPath: string } {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-first-write-"));
    tempDirs.push(agentDir);
    return {
      storage: new FileSettingsStorage(process.cwd(), agentDir),
      settingsPath: path.join(agentDir, "settings.json"),
    };
  }

  it("merges a setting committed by another process while the file did not exist yet", () => {
    const { storage, settingsPath } = makeStorage();

    storage.withLock("global", (current) => {
      // First invocation: the file does not exist yet (current === undefined).
      // Simulate the concurrent first write: the other process creates the
      // settings file with its own field between our unlocked read and our
      // write. The pre-fix code then truncates the file with our merge from
      // an empty base, silently dropping the foreign field.
      if (current === undefined) {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify({ theme: "foreign-theme" }, null, 2));
        return JSON.stringify({ defaultModel: "mine" }, null, 2);
      }
      // Locked re-read: merge our field on top of the foreign content.
      return JSON.stringify({ ...JSON.parse(current), defaultModel: "mine" }, null, 2);
    });

    expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toEqual({
      defaultModel: "mine",
      theme: "foreign-theme",
    });
  });

  it("does not create the settings directory for a read-only load", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-readonly-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "settings-readonly-cwd-"));
    tempDirs.push(agentDir, cwd);
    const storage = new FileSettingsStorage(cwd, agentDir);

    storage.withLock("project", (current) => {
      expect(current).toBeUndefined();
      return undefined;
    });

    // The read-only path must stay lazy: no `.openclaw/` directory and no
    // lock file materialize just because settings were loaded.
    expect(fs.existsSync(path.join(cwd, ".openclaw"))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "settings.json.lock"))).toBe(false);
  });

  it("merges settings written by two managers for the same scope", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-two-managers-"));
    tempDirs.push(agentDir);

    const first = SettingsManager.create(process.cwd(), agentDir);
    first.setTheme("theme-a");
    await first.flush();

    const second = SettingsManager.create(process.cwd(), agentDir);
    second.setDefaultModel("model-b");
    await second.flush();

    const settingsPath = path.join(agentDir, "settings.json");
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toMatchObject({
      theme: "theme-a",
      defaultModel: "model-b",
    });
  });
});
