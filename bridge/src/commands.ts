import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CronManager, validateCronPayload, type CronJob } from "./cron.js";
import type {
  ClaimedCommand,
  CommandResult,
  ExecOutcome,
  MinerProvider,
} from "./types.js";

/** The only command types the bridge will ever execute (contract allowlist). */
export const COMMAND_ALLOWLIST = [
  "miner.status",
  "miner.run",
  "miner.restart",
  "miner.reinstall",
  "miner.hold",
  "miner.unhold",
  "cron.install",
  "cron.list",
  "cron.remove",
] as const;

export interface CommandExecutorDeps {
  provider: MinerProvider;
  /** Registered capabilities of this agent; execution requires allowlist ∩ capabilities. */
  capabilities: string[];
  /** Bridge dir — the hold flag lives here (watchdog integration point). */
  bridgeDir: string;
  /** Live view of the server-provided minimum memory threshold (GiB). */
  getMinMemStartGib: () => number;
  /** Generic cron job manager (CONTRACT-7); payload-validated before use. */
  cron: CronManager;
}

function fmtGib(n: number): string {
  return n.toFixed(2);
}

/**
 * Executes claimed commands against the local miner provider.
 *
 * Safety rules (contract §Bridge / §Command execution):
 * - Anything outside the allowlist, or outside the agent's registered
 *   capabilities, is rejected with REJECTED_SCOPE and never executed.
 * - miner.run / miner.restart / miner.reinstall first check available memory
 *   against the server-provided min_mem_start_gib; below it the command fails
 *   with LOW_MEMORY and the actual memory figure — no doomed start attempt.
 */
export class CommandExecutor {
  private readonly deps: CommandExecutorDeps;

  constructor(deps: CommandExecutorDeps) {
    this.deps = deps;
  }

  get holdFlagPath(): string {
    return join(this.deps.bridgeDir, "hold");
  }

  async execute(cmd: ClaimedCommand): Promise<CommandResult> {
    const { provider, capabilities } = this.deps;

    if (!COMMAND_ALLOWLIST.includes(cmd.type as (typeof COMMAND_ALLOWLIST)[number])) {
      return {
        status: "failed",
        error_reason: "REJECTED_SCOPE",
        output: `Tipe perintah tidak dikenal / tidak diizinkan: ${cmd.type}`,
      };
    }
    if (!capabilities.includes(cmd.type)) {
      return {
        status: "failed",
        error_reason: "REJECTED_SCOPE",
        output: `Perintah ${cmd.type} di luar kemampuan (capabilities) agent ini.`,
      };
    }

    try {
      switch (cmd.type) {
        case "miner.status": {
          const snapshot = await provider.snapshot();
          return { status: "succeeded", exit_code: 0, output: JSON.stringify(snapshot) };
        }
        case "miner.run":
          return await this.startLike("run");
        case "miner.restart":
          return await this.startLike("restart");
        case "miner.reinstall":
          return await this.startLike("reinstall");
        case "miner.hold": {
          mkdirSync(this.deps.bridgeDir, { recursive: true });
          writeFileSync(this.holdFlagPath, new Date().toISOString() + "\n", "utf8");
          return {
            status: "succeeded",
            exit_code: 0,
            output: "Auto-recovery ditahan (flag hold ditulis).",
          };
        }
        case "miner.unhold": {
          try {
            unlinkSync(this.holdFlagPath);
          } catch {
            /* flag already absent — unhold is idempotent */
          }
          return {
            status: "succeeded",
            exit_code: 0,
            output: "Auto-recovery dilanjutkan (flag hold dihapus).",
          };
        }
        case "cron.install": {
          const invalid = validateCronPayload(cmd.type, cmd.payload);
          if (invalid) {
            return { status: "failed", error_reason: "INVALID_PAYLOAD", output: invalid };
          }
          const p = cmd.payload as unknown as CronJob;
          const job: CronJob = { name: p.name, schedule: p.schedule.trim().replace(/\s+/g, " "), command: p.command.trim() };
          await this.deps.cron.install(job);
          return {
            status: "succeeded",
            exit_code: 0,
            output: `Cron job "${job.name}" terpasang: ${job.schedule} ${job.command}`,
          };
        }
        case "cron.list": {
          const jobs = await this.deps.cron.list();
          return { status: "succeeded", exit_code: 0, output: JSON.stringify({ jobs }) };
        }
        case "cron.remove": {
          const invalid = validateCronPayload(cmd.type, cmd.payload);
          if (invalid) {
            return { status: "failed", error_reason: "INVALID_PAYLOAD", output: invalid };
          }
          const name = (cmd.payload as { name: string }).name;
          const removed = await this.deps.cron.remove(name);
          return {
            status: "succeeded",
            exit_code: 0,
            output: removed
              ? `Cron job "${name}" dihapus.`
              : `Cron job "${name}" tidak ditemukan (sudah tidak ada).`,
          };
        }
        default:
          return {
            status: "failed",
            error_reason: "REJECTED_SCOPE",
            output: `Tipe perintah tidak dikenal / tidak diizinkan: ${cmd.type}`,
          };
      }
    } catch (err) {
      return {
        status: "failed",
        error_reason: "EXEC_ERROR",
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Shared path for run/restart/reinstall: memory gate, then provider call. */
  private async startLike(kind: "run" | "restart" | "reinstall"): Promise<CommandResult> {
    const { provider } = this.deps;
    const mem = await provider.memAvailableGib();
    const min = this.deps.getMinMemStartGib();
    if (mem < min) {
      return {
        status: "failed",
        error_reason: "LOW_MEMORY",
        output:
          `Memori tersedia ${fmtGib(mem)} GiB di bawah ambang start ${fmtGib(min)} GiB ` +
          `(LOW_MEMORY, mem_available_gib=${fmtGib(mem)}, min_mem_start_gib=${fmtGib(min)}). ` +
          "Miner tidak dicoba start.",
      };
    }
    const outcome: ExecOutcome =
      kind === "run"
        ? await provider.run()
        : kind === "restart"
          ? await provider.restart()
          : await provider.reinstall();
    if (outcome.ok) {
      return { status: "succeeded", exit_code: outcome.exit_code ?? 0, output: outcome.message };
    }
    return {
      status: "failed",
      error_reason: outcome.error_reason ?? "EXEC_FAILED",
      exit_code: outcome.exit_code,
      output: outcome.message,
    };
  }
}
