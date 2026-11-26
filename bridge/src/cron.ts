import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Generic cron jobs for the bridge (CONTRACT-7, internal scheduler).
 *
 * The bridge is its own scheduler. The agent VMs have no system cron —
 * no crontab binary, no daemon — and a system crontab would not survive
 * VM replacement anyway: only the bridge directory (~/workspace)
 * persists. Depending on crontab would also mean the server never learns
 * whether a job actually ran.
 *
 * Storage: one JSON file per job in `<bridgeDir>/jobs/<name>.json`, next
 * to the bridge identity, so jobs survive VM replacement with it. Writes
 * are atomic (temp file + rename); a corrupt job file is skipped with a
 * log line at load and never crashes the bridge.
 *
 * Scheduling: the bridge's main loop calls CronScheduler.tick() once per
 * cycle. A job whose scheduled time passed while the bridge was down
 * runs exactly ONCE (missed slots are never replayed one by one); a job
 * still running when its next slot arrives is skipped for that slot
 * (reported as skipped_overlap); every run is time-boxed by
 * CRON_JOB_TIMEOUT_MS. Each outcome is reported to the server through
 * the bridge's existing event channel as a CRON_RUN event.
 *
 * Execution: jobs run WITHOUT a shell — the command is split on
 * whitespace and spawned directly (execFile semantics). There is no
 * piping, redirection, variable expansion, or ~ expansion; anything
 * complex belongs in a script file the command points at. Validation
 * rejects shell metacharacters outright (see isValidCronCommand).
 *
 * Schedules are standard 5-field numeric cron expressions, evaluated in
 * the VM's local time.
 */

/** Maximum wall-clock time for one job run. */
export const CRON_JOB_TIMEOUT_MS = 600_000;
/** Combined stdout+stderr kept in memory per run. */
const OUTPUT_CAPTURE_CHARS = 64 * 1024;
/** Tail of the captured output included in a run report. */
const OUTPUT_TAIL_CHARS = 2000;

export interface CronJob {
  name: string;
  schedule: string;
  command: string;
}

export type CronRunStatus = "succeeded" | "failed" | "timeout";

export interface CronJobRecord extends CronJob {
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_status: CronRunStatus | null;
  last_exit_code: number | null;
  last_duration_ms: number | null;
  /** ISO time of the next planned run. */
  next_run_at: string;
}

/** One execution report, sent to the server as a CRON_RUN event. */
export interface CronRunReport {
  name: string;
  scheduled_at: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: CronRunStatus | "skipped_overlap";
  exit_code: number | null;
  output_tail: string;
}

/** Persistence for job records — one file per job in the real store. */
export interface CronStore {
  /** Create the backing storage if needed. */
  init(): Promise<void>;
  loadAll(): Promise<CronJobRecord[]>;
  saveJob(job: CronJobRecord): Promise<void>;
  removeJob(name: string): Promise<void>;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are Sunday)
];
/**
 * Shell metacharacters are rejected in job commands: jobs are executed
 * without a shell, so these characters could never do what their author
 * meant — accepting them would silently change the command's meaning.
 */
const SHELL_META_RE = /[;|&`$><\r\n\0]/;

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
  return trimmed.length >= 1 && trimmed.length <= 2000 && !SHELL_META_RE.test(command);
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
    if (!isValidCronCommand(p.command)) return "Payload cron.install: command harus teks 1–2000 karakter dalam satu baris, tanpa karakter shell (; | & ` $ > <).";
    return null;
  }
  if (type === "cron.remove") {
    if (!isValidCronName(p.name)) return "Payload cron.remove: name tidak valid.";
    return null;
  }
  return null;
}

/**
 * Split a job command into executable + arguments on whitespace. This is
 * deliberately NOT shell parsing: quotes are ordinary characters and no
 * expansion of any kind happens.
 */
export function parseCommandArgs(command: string): { file: string; args: string[] } | null {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { file: parts[0], args: parts.slice(1) };
}

// ------------------------------------------------------- next run time

function expandField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const [, base, rangeEnd, stepStr] = m;
    const step = stepStr !== undefined ? Number(stepStr) : 1;
    if (step < 1) return null;
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (rangeEnd !== undefined) {
      lo = Number(base);
      hi = Number(rangeEnd);
    } else if (stepStr !== undefined) {
      lo = Number(base);
      hi = max;
    } else {
      lo = Number(base);
      hi = lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * The next time a 5-field cron schedule fires, strictly after `from`
 * (minute granularity, local time). Classic cron day semantics: when
 * BOTH day-of-month and day-of-week are restricted, a day matches on
 * EITHER. Returns null when nothing matches within 366 days (e.g.
 * 30 February) — such a job is simply never scheduled.
 */
export function nextRunAfter(schedule: string, from: Date): Date | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((f, i) => expandField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1]));
  if (sets.some((s) => s === null)) return null;
  const [minutes, hours, doms, months, dowsRaw] = sets as Array<Set<number>>;
  const dows = new Set([...dowsRaw].map((d) => (d === 7 ? 0 : d)));
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";

  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i += 1) {
    if (minutes.has(t.getMinutes()) && hours.has(t.getHours()) && months.has(t.getMonth() + 1)) {
      const domMatch = doms.has(t.getDate());
      const dowMatch = dows.has(t.getDay());
      const dayOk = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
      if (dayOk) return new Date(t.getTime());
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

/** Where a job with no computable next run is parked (~a year out). */
function farFuture(from: Date): string {
  return new Date(from.getTime() + 366 * 24 * 3600 * 1000).toISOString();
}

function computeNext(schedule: string, from: Date): string {
  return nextRunAfter(schedule, from)?.toISOString() ?? farFuture(from);
}

// ------------------------------------------------------------ storage

function isJobRecord(v: unknown): v is CronJobRecord {
  if (typeof v !== "object" || v === null) return false;
  const j = v as Record<string, unknown>;
  return (
    isValidCronName(j.name) &&
    isValidCronSchedule(j.schedule) &&
    typeof j.command === "string" &&
    typeof j.next_run_at === "string"
  );
}

function normalizeRecord(j: CronJobRecord): CronJobRecord {
  return {
    name: j.name,
    schedule: j.schedule,
    command: j.command,
    created_at: typeof j.created_at === "string" ? j.created_at : j.next_run_at,
    updated_at: typeof j.updated_at === "string" ? j.updated_at : j.next_run_at,
    last_run_at: typeof j.last_run_at === "string" ? j.last_run_at : null,
    last_status: j.last_status === "succeeded" || j.last_status === "failed" || j.last_status === "timeout" ? j.last_status : null,
    last_exit_code: typeof j.last_exit_code === "number" ? j.last_exit_code : null,
    last_duration_ms: typeof j.last_duration_ms === "number" ? j.last_duration_ms : null,
    next_run_at: j.next_run_at,
  };
}

/**
 * Job records as one JSON file per job in a directory inside the bridge
 * directory (`<bridgeDir>/jobs/`). A file that cannot be parsed is
 * reported through onCorrupt, skipped, and never executed.
 */
export class FileCronStore implements CronStore {
  constructor(
    private readonly dir: string,
    private readonly onCorrupt?: (file: string) => void,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private pathFor(name: string): string {
    // Names are validated to a filename-safe alphabet before this is used.
    return join(this.dir, `${name}.json`);
  }

  async loadAll(): Promise<CronJobRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return []; // directory not created yet = no jobs
    }
    const jobs: CronJobRecord[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.dir, file), "utf8"));
        if (isJobRecord(parsed)) jobs.push(normalizeRecord(parsed));
        else this.onCorrupt?.(file);
      } catch {
        this.onCorrupt?.(file);
      }
    }
    return jobs;
  }

  async saveJob(job: CronJobRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${job.name}.json.tmp-${process.pid}`);
    await writeFile(tmp, JSON.stringify(job, null, 2) + "\n", "utf8");
    await rename(tmp, this.pathFor(job.name));
  }

  async removeJob(name: string): Promise<void> {
    await unlink(this.pathFor(name)).catch(() => {
      /* already gone — removal is idempotent */
    });
  }
}

// ------------------------------------------------------------ manager

/**
 * Holds the authoritative job list for this bridge process (the command
 * executor and the scheduler share one instance, loaded once at startup)
 * and writes every change through to the store.
 */
export class CronManager {
  private jobs: CronJobRecord[] | null = null;

  constructor(private readonly store: CronStore) {}

  private async ensureLoaded(): Promise<CronJobRecord[]> {
    if (this.jobs === null) this.jobs = await this.store.loadAll();
    return this.jobs;
  }

  /**
   * Startup pass: create the jobs directory, load every job file, and
   * recompute next_run_at from the start time for jobs that are not
   * already due (a due job keeps its past next_run_at so the first tick
   * runs it exactly once — the catch-up rule).
   */
  async startup(now = new Date()): Promise<void> {
    await this.store.init();
    const jobs = await this.ensureLoaded();
    for (const job of jobs) {
      if (new Date(job.next_run_at).getTime() > now.getTime()) {
        const next = computeNext(job.schedule, now);
        if (next !== job.next_run_at) {
          job.next_run_at = next;
          await this.store.saveJob(job);
        }
      }
    }
  }

  /** Idempotent per name: re-installing replaces schedule/command. */
  async install(job: CronJob, now = new Date()): Promise<CronJobRecord> {
    const jobs = await this.ensureLoaded();
    const existing = jobs.find((j) => j.name === job.name);
    const record: CronJobRecord = {
      name: job.name,
      schedule: job.schedule,
      command: job.command,
      created_at: existing?.created_at ?? now.toISOString(),
      updated_at: now.toISOString(),
      last_run_at: existing?.last_run_at ?? null,
      last_status: existing?.last_status ?? null,
      last_exit_code: existing?.last_exit_code ?? null,
      last_duration_ms: existing?.last_duration_ms ?? null,
      next_run_at: computeNext(job.schedule, now),
    };
    if (existing) jobs[jobs.indexOf(existing)] = record;
    else jobs.push(record);
    await this.store.saveJob(record);
    return record;
  }

  async remove(name: string): Promise<boolean> {
    const jobs = await this.ensureLoaded();
    const idx = jobs.findIndex((j) => j.name === name);
    if (idx === -1) return false;
    jobs.splice(idx, 1);
    await this.store.removeJob(name);
    return true;
  }

  async list(): Promise<CronJobRecord[]> {
    return [...(await this.ensureLoaded())];
  }

  /** Record a finished run: store its result and schedule the next one. */
  async applyRun(
    name: string,
    run: { finished_at: string; status: CronRunStatus; exit_code: number | null; duration_ms: number },
  ): Promise<CronJobRecord | null> {
    const jobs = await this.ensureLoaded();
    const job = jobs.find((j) => j.name === name);
    if (!job) return null;
    job.last_run_at = run.finished_at;
    job.last_status = run.status;
    job.last_exit_code = run.exit_code;
    job.last_duration_ms = run.duration_ms;
    job.updated_at = run.finished_at;
    job.next_run_at = computeNext(job.schedule, new Date(run.finished_at));
    await this.store.saveJob(job);
    return job;
  }

  /** Push a job's next run forward without running it (still busy). */
  async advanceNext(name: string, now = new Date()): Promise<void> {
    const jobs = await this.ensureLoaded();
    const job = jobs.find((j) => j.name === name);
    if (!job) return;
    job.next_run_at = computeNext(job.schedule, now);
    job.updated_at = now.toISOString();
    await this.store.saveJob(job);
  }
}

// ------------------------------------------------------------ runner

export interface JobRunResult {
  status: CronRunStatus;
  exit_code: number | null;
  duration_ms: number;
  output_tail: string;
}

export interface JobRunner {
  run(command: string, timeoutMs: number): Promise<JobRunResult>;
}

/**
 * Runs a job command WITHOUT a shell: the command is split on whitespace
 * and spawned directly. Environment is inherited from the bridge process;
 * nothing is added. Output is captured up to OUTPUT_CAPTURE_CHARS.
 */
export class ExecFileJobRunner implements JobRunner {
  constructor(private readonly cwd?: string) {}

  run(command: string, timeoutMs: number): Promise<JobRunResult> {
    const started = Date.now();
    const parsed = parseCommandArgs(command);
    if (!parsed) {
      return Promise.resolve({ status: "failed", exit_code: null, duration_ms: 0, output_tail: "command kosong" });
    }
    return new Promise((resolve) => {
      const child = spawn(parsed.file, parsed.args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        ...(this.cwd ? { cwd: this.cwd } : {}),
      });
      let buffer = "";
      const append = (d: Buffer) => {
        buffer = (buffer + d.toString("utf8")).slice(-OUTPUT_CAPTURE_CHARS);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          status: "failed",
          exit_code: null,
          duration_ms: Date.now() - started,
          output_tail: (buffer + String(err)).slice(-OUTPUT_TAIL_CHARS),
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          status: timedOut ? "timeout" : code === 0 ? "succeeded" : "failed",
          exit_code: code,
          duration_ms: Date.now() - started,
          output_tail: buffer.slice(-OUTPUT_TAIL_CHARS),
        });
      });
    });
  }
}

// ------------------------------------------------------------ scheduler

export interface CronSchedulerOptions {
  /** Per-job wall-clock limit; default CRON_JOB_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Called for every run outcome, including skipped_overlap. */
  onReport?: (report: CronRunReport) => void;
}

export class CronScheduler {
  private readonly running = new Set<string>();

  constructor(
    private readonly manager: CronManager,
    private readonly runner: JobRunner,
    private readonly opts: CronSchedulerOptions = {},
  ) {}

  /**
   * One scheduling pass, called from the bridge's main loop. A job is due
   * when its next_run_at is not in the future — which is also the
   * catch-up rule: after downtime the job runs exactly once here, then
   * applyRun schedules from the finish time. Executions are started
   * without blocking the loop; a failing job never stops the scheduler.
   */
  async tick(now = new Date()): Promise<void> {
    let jobs: CronJobRecord[];
    try {
      jobs = await this.manager.list();
    } catch {
      return; // store unreadable this pass; try again next cycle
    }
    for (const job of jobs) {
      if (new Date(job.next_run_at).getTime() > now.getTime()) continue;
      const scheduledAt = job.next_run_at; // capture before any mutation
      if (this.running.has(job.name)) {
        await this.manager.advanceNext(job.name, now).catch(() => {});
        this.report({
          name: job.name,
          scheduled_at: scheduledAt,
          started_at: now.toISOString(),
          finished_at: now.toISOString(),
          duration_ms: 0,
          status: "skipped_overlap",
          exit_code: null,
          output_tail: "",
        });
        continue;
      }
      this.running.add(job.name);
      void this.execute(job, now, scheduledAt).finally(() => this.running.delete(job.name));
    }
  }

  private async execute(job: CronJobRecord, now: Date, scheduledAt: string): Promise<void> {
    const startedAt = now;
    let result: JobRunResult;
    try {
      result = await this.runner.run(job.command, this.opts.timeoutMs ?? CRON_JOB_TIMEOUT_MS);
    } catch (err) {
      result = {
        status: "failed",
        exit_code: null,
        duration_ms: Date.now() - startedAt.getTime(),
        output_tail: String(err).slice(-OUTPUT_TAIL_CHARS),
      };
    }
    const finishedAt = new Date(startedAt.getTime() + result.duration_ms);
    const updated = await this.manager
      .applyRun(job.name, {
        finished_at: finishedAt.toISOString(),
        status: result.status,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
      })
      .catch(() => null);
    if (updated) {
      this.report({
        name: job.name,
        scheduled_at: scheduledAt,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: result.duration_ms,
        status: result.status,
        exit_code: result.exit_code,
        output_tail: result.output_tail,
      });
    }
  }

  private report(report: CronRunReport): void {
    if (!this.opts.onReport) return;
    try {
      this.opts.onReport(report);
    } catch {
      /* reporting must never break scheduling */
    }
  }
}
