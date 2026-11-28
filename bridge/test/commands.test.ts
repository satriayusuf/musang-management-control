import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandExecutor } from "../src/commands.js";
import { DEFAULT_CAPABILITIES } from "../src/config.js";
import { DemoMiner } from "../src/miner-demo.js";
import type { ClaimedCommand } from "../src/types.js";

let bridgeDir: string;

beforeEach(() => {
  bridgeDir = mkdtempSync(join(tmpdir(), "muse-bridge-test-"));
});

afterEach(() => {
  rmSync(bridgeDir, { recursive: true, force: true });
});

function makeExecutor(
  miner: DemoMiner,
  overrides: { capabilities?: string[]; minMem?: number } = {},
): CommandExecutor {
  return new CommandExecutor({
    provider: miner,
    capabilities: overrides.capabilities ?? [...DEFAULT_CAPABILITIES],
    bridgeDir,
    getMinMemStartGib: () => overrides.minMem ?? 5,
    serverUrl: "http://127.0.0.1:9", // unreachable on purpose; only bridge.update would use it
  });
}

function cmd(type: string, payload: Record<string, unknown> = {}): ClaimedCommand {
  return { id: "cmd_test", type, payload };
}

describe("CommandExecutor", () => {
  it("rejects miner.run with LOW_MEMORY when memory is below the start threshold", async () => {
    const miner = new DemoMiner({ startState: "inactive", memGib: 2.4 });
    const executor = makeExecutor(miner, { minMem: 5 });
    const result = await executor.execute(cmd("miner.run"));
    expect(result.status).toBe("failed");
    expect(result.error_reason).toBe("LOW_MEMORY");
    expect(result.output).toContain("2.40");
    expect(result.output).toContain("5");
    // The miner must NOT have been started.
    expect((await miner.snapshot()).service_state).toBe("inactive");
  });

  it("runs the miner when memory is sufficient", async () => {
    const miner = new DemoMiner({ startState: "inactive", memGib: 6.8 });
    const executor = makeExecutor(miner);
    const result = await executor.execute(cmd("miner.run"));
    expect(result.status).toBe("succeeded");
    expect((await miner.snapshot()).service_state).toBe("active");
  });

  it("applies the LOW_MEMORY gate to restart and reinstall too", async () => {
    const miner = new DemoMiner({ startState: "inactive", memGib: 3.1 });
    const executor = makeExecutor(miner);
    for (const type of ["miner.restart", "miner.reinstall"]) {
      const result = await executor.execute(cmd(type));
      expect(result.status).toBe("failed");
      expect(result.error_reason).toBe("LOW_MEMORY");
    }
    expect((await miner.snapshot()).service_state).toBe("inactive");
  });

  it("rejects command types outside the allowlist", async () => {
    const miner = new DemoMiner();
    const executor = makeExecutor(miner);
    const result = await executor.execute(cmd("shell.exec"));
    expect(result.status).toBe("failed");
    expect(result.error_reason).toBe("REJECTED_SCOPE");
  });

  it("rejects allowlisted commands outside the agent's capabilities", async () => {
    const miner = new DemoMiner({ startState: "inactive" });
    const executor = makeExecutor(miner, { capabilities: ["miner.status"] });
    const result = await executor.execute(cmd("miner.run"));
    expect(result.status).toBe("failed");
    expect(result.error_reason).toBe("REJECTED_SCOPE");
    expect((await miner.snapshot()).service_state).toBe("inactive");
  });

  it("miner.status succeeds and returns the snapshot as JSON output", async () => {
    const miner = new DemoMiner({ seed: 9 });
    const executor = makeExecutor(miner);
    const result = await executor.execute(cmd("miner.status"));
    expect(result.status).toBe("succeeded");
    const snapshot = JSON.parse(result.output!) as { service_state: string };
    expect(snapshot.service_state).toBe("active");
  });

  it("miner.hold writes the hold flag and miner.unhold removes it (idempotent)", async () => {
    const miner = new DemoMiner();
    const executor = makeExecutor(miner);
    const flag = join(bridgeDir, "hold");
    expect(existsSync(flag)).toBe(false);

    const hold = await executor.execute(cmd("miner.hold"));
    expect(hold.status).toBe("succeeded");
    expect(existsSync(flag)).toBe(true);

    const unhold = await executor.execute(cmd("miner.unhold"));
    expect(unhold.status).toBe("succeeded");
    expect(existsSync(flag)).toBe(false);

    const unholdAgain = await executor.execute(cmd("miner.unhold"));
    expect(unholdAgain.status).toBe("succeeded");
  });

});
