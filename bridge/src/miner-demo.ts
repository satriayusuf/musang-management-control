import type { ExecOutcome, MinerProvider, MinerSnapshot } from "./types.js";

export interface DemoMinerOptions {
  startState?: "active" | "inactive";
  /** Simulated MemAvailable in GiB (DEMO_MEM_GIB, default 6.8). */
  memGib?: number;
  /** Seed for the deterministic-ish random walk. */
  seed?: number;
}

const HASHRATE_MIN = 1.4;
const HASHRATE_MAX = 1.91;

/**
 * Simulated miner for demo mode. No real miner is touched.
 *
 * State flips only via commands (run/restart/reinstall) or stop(); each
 * (re)start begins a new miner session (session_no++, shares reset), like the
 * real recovery flow. While active, hashrate random-walks inside
 * 1.4–1.91 H/s and shares/job height advance on every tick (one tick = one
 * heartbeat cycle).
 */
export class DemoMiner implements MinerProvider {
  private state: "active" | "inactive";
  private readonly memGib: number;
  private rngState: number;

  private sessionNo = 0;
  private pid: number | null = null;
  private hashrate = 1.65;
  private sharesLocal = 0;
  private jobHeight = 800;
  private lastShareAt: Date | null = null;

  constructor(options: DemoMinerOptions = {}) {
    this.state = options.startState ?? "active";
    this.memGib = options.memGib ?? 6.8;
    this.rngState = (options.seed ?? 1337) >>> 0;
    if (this.state === "active") this.beginSession();
  }

  /** Deterministic LCG so demo runs are reproducible-ish. Returns [0, 1). */
  private rand(): number {
    this.rngState = (Math.imul(this.rngState, 1103515245) + 12345) & 0x7fffffff;
    return this.rngState / 0x80000000;
  }

  private beginSession(): void {
    this.state = "active";
    this.sessionNo += 1;
    this.pid = 1200 + this.sessionNo * 7;
    this.sharesLocal = 0;
    this.jobHeight += Math.floor(this.rand() * 4);
    this.lastShareAt = new Date();
  }

  /** Stop the simulated miner (used by tests; no command maps to this). */
  stop(): void {
    this.state = "inactive";
    this.pid = null;
  }

  get serviceState(): "active" | "inactive" {
    return this.state;
  }

  get currentSessionNo(): number {
    return this.sessionNo;
  }

  /** Advance one heartbeat cycle of simulated mining. */
  tick(): void {
    if (this.state !== "active") return;
    const step = (this.rand() * 2 - 1) * 0.09;
    this.hashrate = Math.min(HASHRATE_MAX, Math.max(HASHRATE_MIN, this.hashrate + step));
    if (this.rand() < 0.75) {
      this.sharesLocal += 1 + Math.floor(this.rand() * 2);
      this.lastShareAt = new Date();
    }
    if (this.rand() < 0.5) this.jobHeight += 1;
  }

  async snapshot(): Promise<MinerSnapshot> {
    const active = this.state === "active";
    return {
      service_state: this.state,
      pid: active ? this.pid : null,
      session_no: this.sessionNo,
      hashrate_hs: active ? Math.round(this.hashrate * 100) / 100 : 0,
      shares_local: this.sharesLocal,
      last_share_at: this.lastShareAt ? this.lastShareAt.toISOString() : null,
      job_height: this.jobHeight,
      difficulty: 2,
    };
  }

  async memAvailableGib(): Promise<number> {
    return this.memGib;
  }

  async run(): Promise<ExecOutcome> {
    if (this.state === "active") {
      return { ok: true, exit_code: 0, message: "Miner demo sudah berjalan (active)." };
    }
    this.beginSession();
    return {
      ok: true,
      exit_code: 0,
      message: `Miner demo dimulai (sesi ${this.sessionNo}).`,
    };
  }

  async restart(): Promise<ExecOutcome> {
    this.beginSession();
    return {
      ok: true,
      exit_code: 0,
      message: `Miner demo di-restart (sesi ${this.sessionNo}).`,
    };
  }

  async reinstall(): Promise<ExecOutcome> {
    this.beginSession();
    return {
      ok: true,
      exit_code: 0,
      message: `Miner demo di-reinstall dan dimulai (sesi ${this.sessionNo}).`,
    };
  }
}
