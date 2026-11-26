import { execFile } from "node:child_process";
import { fetchMinerStats } from "./miner-stats.js";
import { readMemAvailableGiB } from "./snapshot.js";
import type {
  ExecOutcome,
  MinerProvider,
  MinerServiceState,
  MinerSnapshot,
} from "./types.js";

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runProc(file: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs },
      (err: (Error & { code?: number | string; killed?: boolean }) | null, stdout: string, stderr: string) => {
        if (err) {
          resolve({
            code: typeof err.code === "number" ? err.code : 1,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") || (err.killed ? "timeout" : err.message),
          });
        } else {
          resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        }
      },
    );
  });
}

/** Prefix systemctl with `sudo -n` when not running as root. */
function privileged(args: string[]): string[] {
  const getuid = process.getuid;
  if (typeof getuid === "function" && getuid() !== 0) return ["sudo", "-n", ...args];
  return args;
}

/**
 * Real miner control via systemd. Only the single configured unit
 * (MUSE_MINER_UNIT) is ever touched, and only through the allowlisted
 * operations start/restart (+ the optional reinstall script).
 *
 * Hashrate / shares / job data live inside the miner process. When
 * MUSE_MINER_STATS_URL points at a local endpoint serving them as JSON,
 * the snapshot merges those real numbers in (CONTRACT-6). Otherwise the
 * numeric fields go on the wire as 0 — "not reported" — because the server
 * schema requires numbers; the pool cross-check supplies the real figures.
 */
export class RealMiner implements MinerProvider {
  private readonly unit: string;
  private readonly reinstallScript?: string;
  private readonly statsUrl?: string;
  private readonly statsFetch?: typeof fetch;

  constructor(
    unit: string,
    reinstallScript?: string,
    statsUrl?: string,
    statsFetch?: typeof fetch,
  ) {
    this.unit = unit;
    this.reinstallScript = reinstallScript;
    this.statsUrl = statsUrl;
    this.statsFetch = statsFetch;
  }

  private async systemctl(args: string[], timeoutMs = 15_000): Promise<ProcResult> {
    const full = privileged(["systemctl", ...args]);
    return runProc(full[0], full.slice(1), timeoutMs);
  }

  private async loadState(): Promise<string> {
    if (!this.unit) return "not-found";
    const res = await runProc(
      "systemctl",
      ["show", "-p", "LoadState", "--value", this.unit],
      10_000,
    );
    if (res.code !== 0 && res.stdout.trim() === "") return "not-found";
    return res.stdout.trim();
  }

  private async serviceState(): Promise<MinerServiceState> {
    if (!this.unit) return "unit-missing";
    if ((await this.loadState()) === "not-found") return "unit-missing";
    const res = await runProc("systemctl", ["is-active", this.unit], 10_000);
    const value = res.stdout.trim();
    if (value === "active") return "active";
    if (value === "failed") return "failed";
    return "inactive";
  }

  async snapshot(): Promise<MinerSnapshot> {
    const service_state = await this.serviceState();
    let pid: number | null = null;
    if (this.unit && service_state !== "unit-missing") {
      const res = await runProc(
        "systemctl",
        ["show", "-p", "MainPID", "--value", this.unit],
        10_000,
      );
      const parsed = Number.parseInt(res.stdout.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) pid = parsed;
    }
    const stats = this.statsUrl
      ? await fetchMinerStats(this.statsUrl, this.statsFetch ?? fetch)
      : null;
    return {
      service_state,
      pid,
      session_no: null,
      hashrate_hs: stats?.hashrate_hs ?? 0,
      shares_local: stats?.shares_local ?? 0,
      accepted_shares: stats?.accepted_shares ?? null,
      rejected_shares: stats?.rejected_shares ?? null,
      last_share_at: stats?.last_share_at ?? null,
      job_height: stats?.job_height ?? 0,
      difficulty: stats?.difficulty ?? 0,
    };
  }

  async memAvailableGib(): Promise<number> {
    return readMemAvailableGiB();
  }

  async run(): Promise<ExecOutcome> {
    if (!this.unit) {
      return {
        ok: false,
        error_reason: "NOT_CONFIGURED",
        message: "MUSE_MINER_UNIT belum dikonfigurasi; tidak ada unit miner untuk dijalankan.",
      };
    }
    if ((await this.loadState()) === "not-found") {
      if (!this.reinstallScript) {
        return {
          ok: false,
          error_reason: "UNIT_MISSING",
          message: `Unit ${this.unit} tidak ditemukan dan MUSE_REINSTALL_SCRIPT tidak dikonfigurasi.`,
        };
      }
      const install = await this.runReinstallScript();
      if (!install.ok) return install;
    }
    const res = await this.systemctl(["start", this.unit]);
    return res.code === 0
      ? { ok: true, exit_code: 0, message: `systemctl start ${this.unit} berhasil.` }
      : {
          ok: false,
          exit_code: res.code,
          message: `systemctl start ${this.unit} gagal: ${res.stderr.trim() || res.stdout.trim()}`,
        };
  }

  async restart(): Promise<ExecOutcome> {
    if (!this.unit) {
      return {
        ok: false,
        error_reason: "NOT_CONFIGURED",
        message: "MUSE_MINER_UNIT belum dikonfigurasi; tidak ada unit miner untuk di-restart.",
      };
    }
    const res = await this.systemctl(["restart", this.unit]);
    return res.code === 0
      ? { ok: true, exit_code: 0, message: `systemctl restart ${this.unit} berhasil.` }
      : {
          ok: false,
          exit_code: res.code,
          message: `systemctl restart ${this.unit} gagal: ${res.stderr.trim() || res.stdout.trim()}`,
        };
  }

  private async runReinstallScript(): Promise<ExecOutcome> {
    if (!this.reinstallScript) {
      return {
        ok: false,
        error_reason: "NOT_CONFIGURED",
        message: "MUSE_REINSTALL_SCRIPT tidak dikonfigurasi.",
      };
    }
    const res = await runProc("bash", [this.reinstallScript], 180_000);
    return res.code === 0
      ? { ok: true, exit_code: 0, message: "Skrip reinstall selesai." }
      : {
          ok: false,
          exit_code: res.code,
          message: `Skrip reinstall gagal: ${res.stderr.trim() || res.stdout.trim()}`,
        };
  }

  async reinstall(): Promise<ExecOutcome> {
    const install = await this.runReinstallScript();
    if (!install.ok) return install;
    if (!this.unit) return install;
    const res = await this.systemctl(["start", this.unit]);
    return res.code === 0
      ? { ok: true, exit_code: 0, message: "Reinstall selesai dan miner dimulai." }
      : {
          ok: false,
          exit_code: res.code,
          message: `Reinstall selesai tetapi systemctl start ${this.unit} gagal: ${res.stderr.trim() || res.stdout.trim()}`,
        };
  }
}
