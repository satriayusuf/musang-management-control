import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CronManager,
  CronScheduler,
  ExecFileJobRunner,
  FileCronStore,
  isValidCronSchedule,
  nextRunAfter,
  parseCommandArgs,
  validateCronPayload,
  type CronJobRecord,
  type CronRunReport,
  type CronStore,
  type JobRunResult,
  type JobRunner,
} from "../src/cron.js";

class MemoryStore implements CronStore {
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

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

describe("validation", () => {
  it("accepts standard 5-field schedules and rejects broken ones", () => {
    expect(isValidCronSchedule("*/10 * * * *")).toBe(true);
    expect(isValidCronSchedule("0 7 * * *")).toBe(true);
    expect(isValidCronSchedule("15,45 0-23/2 1 * 0")).toBe(true);
    expect(isValidCronSchedule("*/10 * * *")).toBe(false);
    expect(isValidCronSchedule("61 * * * *")).toBe(false);
    expect(isValidCronSchedule("* * * * MON")).toBe(false);
    expect(isValidCronSchedule("*/0 * * * *")).toBe(false);
  });

  it("validateCronPayload enforces install and remove shapes", () => {
    expect(validateCronPayload("cron.install", { name: "ok-1", schedule: "*/5 * * * *", command: "/bin/true" })).toBeNull();
    expect(validateCronPayload("cron.install", { name: "ada spasi", schedule: "*/5 * * * *", command: "/bin/true" })).not.toBeNull();
    expect(validateCronPayload("cron.install", { name: "ok", schedule: "bukan cron", command: "/bin/true" })).not.toBeNull();
    expect(validateCronPayload("cron.install", { name: "ok", schedule: "*/5 * * * *", command: "dua\nbaris" })).not.toBeNull();
    expect(validateCronPayload("cron.install", { name: "ok", schedule: "*/5 * * * *" })).not.toBeNull();
    expect(validateCronPayload("cron.remove", { name: "ok-1" })).toBeNull();
    expect(validateCronPayload("cron.remove", {})).not.toBeNull();
    expect(validateCronPayload("cron.list", {})).toBeNull();
  });

  it("B10: rejects shell metacharacters in command", () => {
    for (const command of ["/bin/a; /bin/b", "/bin/a | /bin/b", "/bin/a && /bin/b", "/bin/echo `id`", "/bin/echo $(id)", "/bin/a > /tmp/x", "/bin/echo $HOME", "/bin/a < /tmp/in"]) {
      expect(validateCronPayload("cron.install", { name: "ok", schedule: "*/5 * * * *", command })).not.toBeNull();
    }
    expect(validateCronPayload("cron.install", { name: "ok", schedule: "*/5 * * * *", command: "/home/user/scripts/laporan.sh --harian" })).toBeNull();
  });

  it("parseCommandArgs splits on whitespace only — no shell parsing", () => {
    expect(parseCommandArgs("/bin/echo halo dunia")).toEqual({ file: "/bin/echo", args: ["halo", "dunia"] });
    expect(parseCommandArgs("  /bin/true  ")).toEqual({ file: "/bin/true", args: [] });
    expect(parseCommandArgs("   ")).toBeNull();
  });
});

describe("nextRunAfter (B2)", () => {
  it("every minute and step schedules", () => {
    const from = new Date(2026, 10, 27, 4, 3, 30);
    expect(nextRunAfter("* * * * *", from)).toEqual(new Date(2026, 10, 27, 4, 4, 0));
    expect(nextRunAfter("*/5 * * * *", from)).toEqual(new Date(2026, 10, 27, 4, 5, 0));
    expect(nextRunAfter("*/10 * * * *", new Date(2026, 10, 27, 4, 10, 0))).toEqual(new Date(2026, 10, 27, 4, 20, 0));
  });

  it("daily, monthly, weekday, list, and hour-step schedules", () => {
    expect(nextRunAfter("0 7 * * *", new Date(2026, 10, 27, 4, 0))).toEqual(new Date(2026, 10, 27, 7, 0));
    expect(nextRunAfter("0 7 * * *", new Date(2026, 10, 27, 8, 0))).toEqual(new Date(2026, 10, 28, 7, 0));
    expect(nextRunAfter("30 2 1 * *", new Date(2026, 10, 27, 4, 0))).toEqual(new Date(2026, 11, 1, 2, 30));
    // 2026-11-27 is a Friday; next weekday 09:00 after Friday 10:00 is Monday 2026-11-30.
    expect(nextRunAfter("0 9 * * 1-5", new Date(2026, 10, 27, 10, 0))).toEqual(new Date(2026, 10, 30, 9, 0));
    expect(nextRunAfter("0 0,12 * * *", new Date(2026, 10, 27, 4, 0))).toEqual(new Date(2026, 10, 27, 12, 0));
    expect(nextRunAfter("0 */6 * * *", new Date(2026, 10, 27, 1, 0))).toEqual(new Date(2026, 10, 27, 6, 0));
    expect(nextRunAfter("15,45 0-23/2 * * *", new Date(2026, 10, 27, 1, 0))).toEqual(new Date(2026, 10, 27, 2, 15));
  });

  it("Sunday as 0 and as 7 are the same day", () => {
    const from = new Date(2026, 10, 27, 10, 0); // Friday
    const sunday = new Date(2026, 10, 29, 8, 0);
    expect(nextRunAfter("0 8 * * 0", from)).toEqual(sunday);
    expect(nextRunAfter("0 8 * * 7", from)).toEqual(sunday);
  });

  it("day-of-month OR day-of-week when both are restricted", () => {
    // "09:00 on the 1st, and every Monday": after Fri 2026-11-27 10:00 the
    // next hit is Monday 2026-11-30 (before the 1st, Tuesday 2026-12-01).
    expect(nextRunAfter("0 9 1 * 1", new Date(2026, 10, 27, 10, 0))).toEqual(new Date(2026, 10, 30, 9, 0));
  });

  it("leap day is found; impossible dates and garbage return null", () => {
    expect(nextRunAfter("0 0 29 2 *", new Date(2027, 2, 1))).toEqual(new Date(2028, 1, 29, 0, 0));
    expect(nextRunAfter("0 0 30 2 *", new Date(2026, 0, 1))).toBeNull();
    expect(nextRunAfter("0 0 31 4 *", new Date(2026, 0, 1))).toBeNull(); // April has 30 days
    expect(nextRunAfter("bukan cron", new Date())).toBeNull();
  });
});

describe("FileCronStore — one file per job", () => {
  it("B3/B8: install twice leaves exactly one file; a fresh manager reads it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cron-test-"));
    try {
      const jobsDir = join(dir, "jobs");
      const manager = new CronManager(new FileCronStore(jobsDir));
      await manager.install({ name: "job-a", schedule: "*/10 * * * *", command: "/bin/a" }, new Date(2026, 10, 27, 4, 3));
      await manager.install({ name: "job-a", schedule: "0 * * * *", command: "/bin/b" }, new Date(2026, 10, 27, 4, 4));
      expect(readdirSync(jobsDir)).toEqual(["job-a.json"]);

      const fresh = new CronManager(new FileCronStore(jobsDir));
      const jobs = await fresh.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ name: "job-a", schedule: "0 * * * *", command: "/bin/b", last_status: null });
      expect(jobs[0].next_run_at).toBe(new Date(2026, 10, 27, 5, 0).toISOString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("B11: a corrupt job file is skipped and reported, valid jobs still load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cron-test-"));
    try {
      const jobsDir = join(dir, "jobs");
      mkdirSync(jobsDir, { recursive: true });
      writeFileSync(join(jobsDir, "rusak.json"), "{ ini bukan json", "utf8");
      const corrupt: string[] = [];
      const manager = new CronManager(new FileCronStore(jobsDir, (f) => corrupt.push(f)));
      await manager.install({ name: "sehat", schedule: "*/10 * * * *", command: "/bin/true" }, new Date(2026, 10, 27, 4, 3));
      // install() loads first — the corrupt file must have been noticed and skipped.
      expect(corrupt).toEqual(["rusak.json"]);
      expect((await manager.list()).map((j) => j.name)).toEqual(["sehat"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CronManager", () => {
  it("install → list → remove; re-install keeps created_at and last-run fields", async () => {
    const manager = new CronManager(new MemoryStore());
    const first = await manager.install({ name: "job-a", schedule: "*/10 * * * *", command: "/bin/a" }, new Date(2026, 10, 27, 4, 3));
    expect(first.next_run_at).toBe(new Date(2026, 10, 27, 4, 10).toISOString());

    await manager.applyRun("job-a", {
      finished_at: new Date(2026, 10, 27, 4, 10, 5).toISOString(),
      status: "succeeded",
      exit_code: 0,
      duration_ms: 5000,
    });
    const replaced = await manager.install({ name: "job-a", schedule: "0 * * * *", command: "/bin/b" }, new Date(2026, 10, 27, 4, 30));
    expect(replaced.created_at).toBe(first.created_at);
    expect(replaced.last_status).toBe("succeeded");
    expect(replaced.last_exit_code).toBe(0);
    expect(await manager.list()).toHaveLength(1);

    expect(await manager.remove("job-a")).toBe(true);
    expect(await manager.remove("job-a")).toBe(false);
    expect(await manager.list()).toEqual([]);
  });
});

class FakeRunner implements JobRunner {
  calls: string[] = [];
  result: JobRunResult = { status: "succeeded", exit_code: 0, duration_ms: 1200, output_tail: "done" };
  gate: Promise<void> | null = null;
  async run(command: string): Promise<JobRunResult> {
    this.calls.push(command);
    if (this.gate) await this.gate;
    return this.result;
  }
}

describe("CronScheduler", () => {
  it("runs a due job once, records last_* fields, and reports the run (B9 bridge side)", async () => {
    const manager = new CronManager(new MemoryStore());
    await manager.install({ name: "job-a", schedule: "*/10 * * * *", command: "/bin/a" }, new Date(2026, 10, 27, 4, 3));
    const runner = new FakeRunner();
    const reports: CronRunReport[] = [];
    const scheduler = new CronScheduler(manager, runner, { onReport: (r) => reports.push(r) });

    await scheduler.tick(new Date(2026, 10, 27, 4, 5)); // not due yet
    await flush();
    expect(runner.calls).toEqual([]);

    await scheduler.tick(new Date(2026, 10, 27, 4, 10)); // due
    await flush();
    expect(runner.calls).toEqual(["/bin/a"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      name: "job-a",
      scheduled_at: new Date(2026, 10, 27, 4, 10).toISOString(),
      status: "succeeded",
      exit_code: 0,
      duration_ms: 1200,
      output_tail: "done",
    });
    const [job] = await manager.list();
    expect(job.last_status).toBe("succeeded");
    expect(job.last_run_at).toBe(new Date(2026, 10, 27, 4, 10, 1, 200).toISOString());
    expect(new Date(job.next_run_at).getTime()).toBeGreaterThan(new Date(2026, 10, 27, 4, 10).getTime());
  });

  it("B5: catch-up after downtime runs the job once, not once per missed slot", async () => {
    const manager = new CronManager(new MemoryStore());
    await manager.install({ name: "job-a", schedule: "*/10 * * * *", command: "/bin/a" }, new Date(2026, 10, 27, 4, 3));
    const runner = new FakeRunner();
    const scheduler = new CronScheduler(manager, runner);
    await scheduler.tick(new Date(2026, 10, 27, 7, 30)); // ~20 slots missed
    await flush();
    expect(runner.calls).toEqual(["/bin/a"]);
    const [job] = await manager.list();
    expect(new Date(job.next_run_at).getTime()).toBeGreaterThan(new Date(2026, 10, 27, 7, 30).getTime());
  });

  it("B6: a slot colliding with a still-running job is skipped and reported", async () => {
    const manager = new CronManager(new MemoryStore());
    await manager.install({ name: "job-a", schedule: "*/10 * * * *", command: "/bin/a" }, new Date(2026, 10, 27, 4, 3));
    const runner = new FakeRunner();
    let release!: () => void;
    runner.gate = new Promise<void>((r) => (release = r));
    const reports: CronRunReport[] = [];
    const scheduler = new CronScheduler(manager, runner, { onReport: (r) => reports.push(r) });

    await scheduler.tick(new Date(2026, 10, 27, 4, 10)); // starts the run
    await scheduler.tick(new Date(2026, 10, 27, 4, 20)); // still running → skip
    await flush();
    expect(runner.calls).toEqual(["/bin/a"]);
    expect(reports.map((r) => r.status)).toEqual(["skipped_overlap"]);
    release();
    await flush();
    expect(reports.map((r) => r.status)).toEqual(["skipped_overlap", "succeeded"]);
  });

  it("B4: a removed job never runs again", async () => {
    const manager = new CronManager(new MemoryStore());
    await manager.install({ name: "job-a", schedule: "*/10 * * * *", command: "/bin/a" }, new Date(2026, 10, 27, 4, 3));
    await manager.remove("job-a");
    const runner = new FakeRunner();
    const scheduler = new CronScheduler(manager, runner);
    await scheduler.tick(new Date(2026, 10, 27, 4, 10));
    await flush();
    expect(runner.calls).toEqual([]);
  });
});

describe("ExecFileJobRunner — real processes, no shell (B1/B7)", () => {
  it("runs a real command and captures its output", async () => {
    const runner = new ExecFileJobRunner();
    const ok = await runner.run("/bin/echo halo dunia", 5000);
    expect(ok.status).toBe("succeeded");
    expect(ok.exit_code).toBe(0);
    expect(ok.output_tail).toContain("halo dunia");

    const fail = await runner.run("/bin/false", 5000);
    expect(fail.status).toBe("failed");
    expect(fail.exit_code).toBe(1);

    const missing = await runner.run("/bin/tidak-ada-binary-ini", 5000);
    expect(missing.status).toBe("failed");
    expect(missing.exit_code).toBeNull();
  });

  it("shell syntax in a job command is inert without a shell", async () => {
    const runner = new ExecFileJobRunner();
    // Even if a metacharacter slipped past validation, execFile passes it
    // as a plain argument — nothing is interpreted.
    const res = await runner.run("/bin/echo a;b", 5000);
    expect(res.status).toBe("succeeded");
    expect(res.output_tail).toContain("a;b");
  });

  it("B7: a run past its timeout is killed and reported as timeout", async () => {
    const runner = new ExecFileJobRunner();
    const res = await runner.run("/bin/sleep 5", 150);
    expect(res.status).toBe("timeout");
    expect(res.duration_ms).toBeLessThan(4000);
  });
});
