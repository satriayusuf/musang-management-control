import { describe, expect, it } from "vitest";
import {
  CronManager,
  isValidCronSchedule,
  parseCronJobs,
  removeCronJob,
  upsertCronJob,
  validateCronPayload,
  type CronRunner,
} from "../src/cron.js";

class FakeRunner implements CronRunner {
  content: string;
  writes = 0;
  constructor(initial = "") {
    this.content = initial;
  }
  async read(): Promise<string> {
    return this.content;
  }
  async write(content: string): Promise<void> {
    this.writes += 1;
    this.content = content;
  }
}

const USER_LINE = "0 3 * * * /home/user/backup.sh";

describe("parseCronJobs", () => {
  it("parses only marked lines and splits schedule from command", () => {
    const content = [
      USER_LINE,
      "*/10 * * * * /usr/bin/curl -s https://example.com/ping # muse-cron:ping-situs",
      "# komentar biasa",
      "0 7 * * * /bin/true # muse-cron:pagi",
      "",
    ].join("\n");
    expect(parseCronJobs(content)).toEqual([
      { name: "ping-situs", schedule: "*/10 * * * *", command: "/usr/bin/curl -s https://example.com/ping" },
      { name: "pagi", schedule: "0 7 * * *", command: "/bin/true" },
    ]);
  });
});

describe("upsertCronJob / removeCronJob", () => {
  it("installs a new job without touching user lines", () => {
    const next = upsertCronJob(USER_LINE + "\n", {
      name: "bersih-log",
      schedule: "*/10 * * * *",
      command: "find ~/logs -name '*.log' -mtime +1 -delete",
    });
    expect(next).toContain(USER_LINE);
    expect(parseCronJobs(next)).toEqual([
      { name: "bersih-log", schedule: "*/10 * * * *", command: "find ~/logs -name '*.log' -mtime +1 -delete" },
    ]);
  });

  it("re-installing the same name replaces the line instead of duplicating", () => {
    const first = upsertCronJob("", { name: "job-a", schedule: "*/5 * * * *", command: "/bin/a" });
    const second = upsertCronJob(first, { name: "job-a", schedule: "0 * * * *", command: "/bin/b" });
    const jobs = parseCronJobs(second);
    expect(jobs).toEqual([{ name: "job-a", schedule: "0 * * * *", command: "/bin/b" }]);
  });

  it("remove drops only the named job and reports existence", () => {
    const content = upsertCronJob(USER_LINE + "\n", { name: "job-a", schedule: "0 * * * *", command: "/bin/a" });
    const { content: after, removed } = removeCronJob(content, "job-a");
    expect(removed).toBe(true);
    expect(parseCronJobs(after)).toEqual([]);
    expect(after).toContain(USER_LINE);
    expect(removeCronJob(after, "job-a").removed).toBe(false);
  });
});

describe("CronManager over a runner", () => {
  it("install → list → remove round-trips through the runner", async () => {
    const runner = new FakeRunner(USER_LINE + "\n");
    const manager = new CronManager(runner);
    await manager.install({ name: "job-a", schedule: "*/10 * * * *", command: "/bin/a --flag" });
    expect(await manager.list()).toEqual([{ name: "job-a", schedule: "*/10 * * * *", command: "/bin/a --flag" }]);
    expect(await manager.remove("job-a")).toBe(true);
    expect(await manager.list()).toEqual([]);
    expect(runner.content).toContain(USER_LINE);
  });
});

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
});
