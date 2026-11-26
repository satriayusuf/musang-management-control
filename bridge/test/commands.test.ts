import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandExecutor } from "../src/commands.js";
import { DEFAULT_CAPABILITIES } from "../src/config.js";
import { CronManager, type CronJobRecord, type CronStore } from "../src/cron.js";
import { DemoMiner } from "../src/miner-demo.js";
import type { ClaimedCommand } from "../src/types.js";

class MemoryCronStore implements CronStore {
  jobs: CronJobRecord[] = [];
  async init(): Promise<void> {}
  async loadAll(): Promise<CronJobRecord[]> {
    return this.jobs.map((j) => ({ ...j }));
  }
  async saveJob(job: CronJobRecord): Promise<void> {
    const idx = this.jobs.findIndex((j) => j.name === job.name);
    if (idx === -1) this.jobs.push({ ...job });
    else this.jobs[idx] = { ...job };
  }
  async removeJob(name: string): Promise<void> {
    this.jobs = this.jobs.filter((j) => j.name !== name);
  }
}

let cronStore: MemoryCronStore;

let bridgeDir: string;

beforeEach(() => {
  bridgeDir = mkdtempSync(join(tmpdir(), "muse-bridge-test-"));
  cronStore = new MemoryCronStore();
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
    cron: new CronManager(cronStore),
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

  it("cron.install stores the job, cron.list reads it back, cron.remove deletes it", async () => {
    const miner = new DemoMiner();
    const executor = makeExecutor(miner);

    const install = await executor.execute(
      cmd("cron.install", { name: "bersih-log", schedule: "*/10 * * * *", command: "/usr/bin/find /home/user/logs -name *.log -mtime +1 -delete" }),
    );
    expect(install.status).toBe("succeeded");
    expect(cronStore.jobs.map((j) => j.name)).toEqual(["bersih-log"]);
    expect(JSON.parse(install.output ?? "{}")).toMatchObject({ name: "bersih-log", schedule: "*/10 * * * *" });

    const list = await executor.execute(cmd("cron.list"));
    expect(list.status).toBe("succeeded");
    const jobs = JSON.parse(list.output ?? "{}").jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: "bersih-log",
      schedule: "*/10 * * * *",
      command: "/usr/bin/find /home/user/logs -name *.log -mtime +1 -delete",
      last_status: null,
    });
    expect(typeof jobs[0].next_run_at).toBe("string");

    const remove = await executor.execute(cmd("cron.remove", { name: "bersih-log" }));
    expect(remove.status).toBe("succeeded");
    expect(cronStore.jobs).toEqual([]);
  });

  it("cron.install rejects an invalid payload and respects capabilities", async () => {
    const miner = new DemoMiner();
    const executor = makeExecutor(miner);
    const bad = await executor.execute(cmd("cron.install", { name: "x", schedule: "bukan-cron", command: "/bin/true" }));
    expect(bad.status).toBe("failed");
    expect(bad.error_reason).toBe("INVALID_PAYLOAD");

    const noCap = makeExecutor(miner, { capabilities: ["miner.status"] });
    const denied = await noCap.execute(cmd("cron.install", { name: "x", schedule: "*/5 * * * *", command: "/bin/true" }));
    expect(denied.status).toBe("failed");
    expect(denied.error_reason).toBe("REJECTED_SCOPE");
  });
});
