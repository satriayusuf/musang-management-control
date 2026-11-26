import { spawn } from "node:child_process";

/**
 * Generic cron job management for the bridge (CONTRACT-7).
 *
 * Jobs installed through the dashboard live in the bridge user's crontab,
 * each on a single line carrying a trailing marker comment:
 *
 *   <schedule> <command> # muse-cron:<name>
 *
 * Install is idempotent per name (re-installing replaces the line), remove
 * drops the marked line, list parses the marked lines back. Lines without
 * the marker — the user's own crontab entries — are never touched.
 */

export interface CronJob {
  name: string;
  schedule: string;
  command: string;
}

/** Reads/writes the whole crontab text. `read` returns "" when none exists. */
export interface CronRunner {
  read(): Promise<string>;
  write(content: string): Promise<void>;
}

const MARKER = "# muse-cron:";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are Sunday)
];

export function isValidCronName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name);
}

function isValidScheduleField(field: string, min: number, max: number): boolean {
  if (!field) return false;
  for (const part of field.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) return false;
    const [, base, rangeEnd, step] = m;
    if (base !== "*") {
      const v = Number(base);
      if (v < min || v > max) return false;
    }
    if (rangeEnd !== undefined) {
      const v = Number(rangeEnd);
      if (v < min || v > max) return false;
    }
    if (step !== undefined && Number(step) < 1) return false;
  }
  return true;
}

/** A standard 5-field numeric cron expression (no month/day names). */
export function isValidCronSchedule(schedule: unknown): schedule is string {
  if (typeof schedule !== "string") return false;
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => isValidScheduleField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1]));
}

export function isValidCronCommand(command: unknown): command is string {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  return trimmed.length >= 1 && trimmed.length <= 2000 && !/[\r\n\0]/.test(command);
}

/**
 * Validate a cron.* command payload. Returns an Indonesian error message,
 * or null when valid. Mirrors the server-side validator (backend
 * services/cron-payload.ts) — the bridge re-checks because a payload can
 * also arrive from templates or older dashboard versions.
 */
export function validateCronPayload(type: string, payload: Record<string, unknown> | null | undefined): string | null {
  const p = payload ?? {};
  if (type === "cron.install") {
    if (!isValidCronName(p.name)) return "Payload cron.install: name tidak valid (huruf/angka/titik/strip/garis bawah, maks 64 karakter).";
    if (!isValidCronSchedule(p.schedule)) return "Payload cron.install: schedule harus ekspresi cron 5 kolom yang valid.";
    if (!isValidCronCommand(p.command)) return "Payload cron.install: command harus teks 1–2000 karakter dalam satu baris.";
    return null;
  }
  if (type === "cron.remove") {
    if (!isValidCronName(p.name)) return "Payload cron.remove: name tidak valid.";
    return null;
  }
  return null;
}

const MARKED_LINE_RE = /^(.*?)\s+# muse-cron:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*$/;

export function parseCronJobs(content: string): CronJob[] {
  const jobs: CronJob[] = [];
  for (const line of content.split("\n")) {
    const m = MARKED_LINE_RE.exec(line);
    if (!m) continue;
    const head = m[1].trim();
    const fields = head.split(/\s+/);
    if (fields.length < 6) continue;
    jobs.push({
      name: m[2],
      schedule: fields.slice(0, 5).join(" "),
      command: fields.slice(5).join(" "),
    });
  }
  return jobs;
}

function withoutJob(content: string, name: string): string {
  const kept = content.split("\n").filter((line) => {
    const m = MARKED_LINE_RE.exec(line);
    return !(m && m[2] === name);
  });
  return kept.join("\n");
}

/** Returns new crontab content with the job installed (replacing same-name). */
export function upsertCronJob(content: string, job: CronJob): string {
  const base = withoutJob(content, job.name).replace(/\n+$/, "");
  const line = `${job.schedule} ${job.command} ${MARKER}${job.name}`;
  return (base ? base + "\n" : "") + line + "\n";
}

/** Returns new crontab content without the named job, and whether it existed. */
export function removeCronJob(content: string, name: string): { content: string; removed: boolean } {
  const next = withoutJob(content, name);
  return { content: next, removed: next !== content };
}

export class CronManager {
  private readonly runner: CronRunner;

  constructor(runner: CronRunner) {
    this.runner = runner;
  }

  async install(job: CronJob): Promise<void> {
    const current = await this.runner.read();
    await this.runner.write(upsertCronJob(current, job));
  }

  async remove(name: string): Promise<boolean> {
    const current = await this.runner.read();
    const { content, removed } = removeCronJob(current, name);
    if (removed) await this.runner.write(content);
    return removed;
  }

  async list(): Promise<CronJob[]> {
    return parseCronJobs(await this.runner.read());
  }
}

/** Real runner backed by the `crontab` binary of the bridge's user. */
export class SystemCronRunner implements CronRunner {
  read(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("crontab", ["-l"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) return resolve(out);
        // "no crontab for <user>" simply means an empty crontab.
        if (/no crontab/i.test(err)) return resolve("");
        reject(new Error(`crontab -l gagal (exit ${code}): ${err.trim()}`));
      });
    });
  }

  write(content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("crontab", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) return resolve();
        reject(new Error(`crontab - gagal (exit ${code}): ${err.trim()}`));
      });
      child.stdin.end(content);
    });
  }
}
