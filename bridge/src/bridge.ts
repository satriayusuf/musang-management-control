import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { BridgeClient, HttpError, NetworkError } from "./client.js";
import { CommandExecutor } from "./commands.js";
import {
  CronManager,
  CronScheduler,
  ExecFileJobRunner,
  FileCronStore,
  type CronRunReport,
} from "./cron.js";
import { ConfigError, loadConfig, type BridgeConfig } from "./config.js";
import { IdentityStore } from "./identity.js";
import { DemoMiner } from "./miner-demo.js";
import { RealMiner } from "./miner-real.js";
import { readBootId, readBootTimeIso, readMemAvailableGiB } from "./snapshot.js";
import { BRIDGE_VERSION } from "./version.js";
import type {
  ClaimedCommand,
  HeartbeatResponse,
  MinerProvider,
  RegisterResponse,
  ServerConfig,
} from "./types.js";

/** Contract defaults; overwritten by whatever the server sends. */
const DEFAULT_SERVER_CONFIG: ServerConfig = {
  heartbeat_interval_sec: 30,
  min_mem_start_gib: 5,
};

const MAX_CONSECUTIVE_FAILURES = 5;

function log(level: "info" | "warn" | "error", message: string): void {
  // Never log the agent token. Messages here contain no secrets by construction.
  console.log(`[muse-bridge ${new Date().toISOString()}] ${level.toUpperCase()} ${message}`);
}

/** Exponential backoff: 1s, 2s, 4s, ... capped at 60s, plus small jitter. */
export function backoffDelayMs(attempt: number): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
  return base + Math.floor(Math.random() * 250);
}

/** Heartbeat interval with ±3s jitter. */
export function jitteredIntervalMs(baseSec: number): number {
  const jitter = Math.random() * 6000 - 3000;
  return Math.max(1000, baseSec * 1000 + jitter);
}

class SupersededError extends Error {}

export class Bridge {
  private readonly cfg: BridgeConfig;
  private readonly store: IdentityStore;
  private readonly client: BridgeClient;
  private readonly provider: MinerProvider;
  private readonly executor: CommandExecutor;
  private readonly cronManager: CronManager;
  private readonly cronScheduler: CronScheduler;

  private serverCfg: ServerConfig = { ...DEFAULT_SERVER_CONFIG };
  private agentId: string | null = null;
  private token: string | null = null;
  private sessionId: string | null = null;
  private shuttingDown = false;

  constructor(cfg: BridgeConfig) {
    this.cfg = cfg;
    this.store = new IdentityStore(cfg.bridgeDir);
    this.client = new BridgeClient(cfg.serverUrl);
    this.provider =
      cfg.mode === "demo"
        ? new DemoMiner({
            startState: cfg.demoMinerStart,
            memGib: cfg.demoMemGib,
            seed: cfg.demoSeed,
          })
        : new RealMiner(cfg.minerUnit, cfg.reinstallScript, cfg.minerStatsUrl);
    // The bridge schedules dashboard cron jobs itself (CONTRACT-7): one
    // JSON file per job in <bridgeDir>/jobs/, next to the bridge
    // identity, so jobs survive VM replacement together with it. Job
    // commands run without a shell from the workspace directory.
    this.cronManager = new CronManager(
      new FileCronStore(join(cfg.bridgeDir, "jobs"), (file) =>
        log("warn", `cron job file ${file} tidak bisa dibaca — dilewati`),
      ),
    );
    this.cronScheduler = new CronScheduler(this.cronManager, new ExecFileJobRunner(dirname(cfg.bridgeDir)), {
      onReport: (report) => this.reportCronRun(report),
    });
    this.executor = new CommandExecutor({
      provider: this.provider,
      capabilities: cfg.capabilities,
      bridgeDir: cfg.bridgeDir,
      getMinMemStartGib: () => this.serverCfg.min_mem_start_gib,
      cron: this.cronManager,
    });
  }

  // -------------------------------------------------------------- lifecycle

  async run(): Promise<void> {
    process.on("SIGTERM", () => void this.shutdown("SIGTERM"));
    process.on("SIGINT", () => void this.shutdown("SIGINT"));
    log(
      "info",
      `starting bridge v${BRIDGE_VERSION} mode=${this.cfg.mode} server=${this.cfg.serverUrl} dir=${this.cfg.bridgeDir}`,
    );
    try {
      await this.cronManager.startup();
    } catch (err) {
      log("warn", `cron startup gagal: ${err instanceof Error ? err.message : String(err)}`);
    }
    while (!this.shuttingDown) {
      try {
        await this.registerPhase();
        await this.cycleLoop();
      } catch (err) {
        if (this.shuttingDown) break;
        if (err instanceof SupersededError) {
          log("warn", "session superseded by a newer bridge — re-registering");
          continue;
        }
        log("error", `main loop error: ${err instanceof Error ? err.message : String(err)}`);
        await this.sleep(backoffDelayMs(2));
      }
    }
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log("info", `received ${signal}, shutting down`);
    if (this.agentId && this.token) {
      try {
        await Promise.race([
          this.client.postEvent(
            this.agentId,
            this.token,
            {
              type: "AGENT_SHUTDOWN",
              description: `Bridge menerima ${signal} dan berhenti dengan bersih.`,
              metadata: { signal },
            },
            2000,
          ),
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
      } catch {
        /* best effort only — the VM may already be gone */
      }
    }
    process.exit(0);
  }

  /** Report one cron job outcome to the server as a CRON_RUN event. */
  private reportCronRun(report: CronRunReport): void {
    if (!this.agentId || !this.token) return;
    const statusText =
      report.status === "succeeded"
        ? "berhasil"
        : report.status === "timeout"
          ? "melebihi batas waktu"
          : report.status === "skipped_overlap"
            ? "dilewati (run sebelumnya masih berjalan)"
            : "gagal";
    void this.client
      .postEvent(
        this.agentId,
        this.token,
        {
          type: "CRON_RUN",
          description: `Cron job "${report.name}" ${statusText} (exit ${report.exit_code ?? "—"}, ${(report.duration_ms / 1000).toFixed(1)} detik).`,
          metadata: { ...report },
        },
        5000,
      )
      .catch(() => {
        /* best effort — a missed report never affects scheduling */
      });
  }

  /** Sleep that returns early (true) when shutdown begins. */
  private async sleep(ms: number): Promise<boolean> {
    const step = 200;
    let elapsed = 0;
    while (elapsed < ms) {
      if (this.shuttingDown) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)));
      elapsed += step;
    }
    return this.shuttingDown;
  }

  // ------------------------------------------------------------- register

  private async registerPhase(): Promise<void> {
    let attempt = 0;
    while (!this.shuttingDown) {
      try {
        await this.tryRegister();
        return;
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) {
          // Token revoked (or pairing code invalid/expired).
          if (this.store.loadToken() && this.cfg.pairingCode) {
            log("warn", "agent token rejected (401) — clearing it and re-pairing");
            this.store.clearToken();
            this.token = null;
            continue;
          }
          log(
            "error",
            "server returned 401 (token revoked or pairing code invalid); retrying with backoff",
          );
        } else if (err instanceof Error && err.message.includes("pairing")) {
          log("error", err.message);
        } else if (err instanceof NetworkError) {
          log("warn", `register failed (network): ${err.message}`);
        } else {
          log("warn", `register failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        attempt += 1;
        if (await this.sleep(backoffDelayMs(attempt))) return;
      }
    }
  }

  private async tryRegister(): Promise<void> {
    const identity = this.store.loadIdentity();
    const storedToken = this.store.loadToken();
    const bootId = readBootId(this.cfg.bridgeDir);
    const bootTime = readBootTimeIso();

    let body: Record<string, unknown>;
    let tokenForRequest: string | undefined;
    let useSelfRegister = false;
    if (identity && storedToken) {
      body = {
        agent_id: identity.agent_id,
        boot_id: bootId,
        boot_time: bootTime,
        bridge_version: BRIDGE_VERSION,
        capabilities: this.cfg.capabilities,
        worker_name: this.cfg.workerName ?? identity.worker_name,
      };
      tokenForRequest = storedToken;
    } else if (this.cfg.pairingCode) {
      body = {
        pairing_code: this.cfg.pairingCode,
        name: this.cfg.agentName,
        worker_name: this.cfg.workerName,
        boot_id: bootId,
        boot_time: bootTime,
        bridge_version: BRIDGE_VERSION,
        capabilities: this.cfg.capabilities,
      };
    } else if (this.cfg.enrollmentKey) {
      // Zero-touch self-enrollment: used ONLY for the first registration.
      // Once a token exists it is always used instead — re-enrolling would
      // create a duplicate agent on the server.
      useSelfRegister = true;
      body = {
        enrollment_key: this.cfg.enrollmentKey,
        agent_name: this.cfg.agentName,
        worker_name: this.cfg.workerName,
        boot_id: bootId,
        boot_time: bootTime,
        bridge_version: BRIDGE_VERSION,
        capabilities: this.cfg.capabilities,
      };
    } else {
      throw new Error(
        "No persistent identity found and neither a pairing code (MUSE_PAIRING_CODE) nor an enrollment key (MUSE_ENROLLMENT_KEY) configured — cannot register.",
      );
    }

    const resp: RegisterResponse = useSelfRegister
      ? await this.client.selfRegister(body)
      : await this.client.register(body, tokenForRequest);

    const rawToken = resp.agent_token ?? resp.token;
    if (rawToken) this.store.saveToken(rawToken);
    this.store.saveIdentity({
      agent_id: resp.agent_id,
      name: identity?.name || this.cfg.agentName,
      worker_name: this.cfg.workerName ?? identity?.worker_name,
    });
    this.agentId = resp.agent_id;
    this.token = this.store.loadToken();
    this.sessionId = resp.session_id;
    this.mergeServerConfig(resp.config);
    log(
      "info",
      `registered agent=${resp.agent_id} session=${resp.session_id} session_no=${resp.session_no ?? "?"}`,
    );
  }

  private mergeServerConfig(config?: Partial<ServerConfig>): void {
    if (!config) return;
    if (typeof config.heartbeat_interval_sec === "number" && config.heartbeat_interval_sec > 0) {
      this.serverCfg.heartbeat_interval_sec = config.heartbeat_interval_sec;
    }
    if (typeof config.min_mem_start_gib === "number" && config.min_mem_start_gib > 0) {
      this.serverCfg.min_mem_start_gib = config.min_mem_start_gib;
    }
    if (typeof config.unreachable_missed_beats === "number") {
      this.serverCfg.unreachable_missed_beats = config.unreachable_missed_beats;
    }
  }

  // ---------------------------------------------------------------- cycle

  private async cycleLoop(): Promise<void> {
    let failures = 0;
    while (!this.shuttingDown) {
      try {
        // Cron scheduling rides this same loop (CONTRACT-7): one tick per
        // cycle; due jobs start without blocking heartbeat or commands.
        await this.cronScheduler.tick().catch(() => {});
        await this.sendHeartbeat();
        const commands = await this.client.pollCommands(this.agentId!, this.token!);
        for (const cmd of commands) {
          if (this.shuttingDown) break;
          await this.handleCommand(cmd);
        }
        failures = 0;
      } catch (err) {
        if (err instanceof HttpError && err.isSuperseded) throw new SupersededError();
        failures += 1;
        log(
          "warn",
          `cycle failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          throw new Error("too many consecutive cycle failures — re-registering");
        }
        if (await this.sleep(backoffDelayMs(failures))) return;
        continue;
      }
      if (await this.sleep(jitteredIntervalMs(this.serverCfg.heartbeat_interval_sec))) return;
    }
  }

  private async buildHeartbeatBody(): Promise<Record<string, unknown>> {
    this.provider.tick?.();
    const miner = await this.provider.snapshot();
    const memAvailable =
      this.cfg.mode === "demo" ? this.cfg.demoMemGib : readMemAvailableGiB();
    if (miner.service_state !== "active" && memAvailable < this.serverCfg.min_mem_start_gib) {
      miner.start_blocked_reason = "LOW_MEMORY";
    }
    miner.hold_active = existsSync(join(this.cfg.bridgeDir, "hold"));
    return {
      session_id: this.sessionId,
      sent_at: new Date().toISOString(),
      host: {
        boot_id: readBootId(this.cfg.bridgeDir),
        mem_available_gib: memAvailable,
      },
      miner,
    };
  }

  private async sendHeartbeat(): Promise<void> {
    const body = await this.buildHeartbeatBody();
    const resp: HeartbeatResponse = await this.client.heartbeat(this.agentId!, this.token!, body);
    if (resp.config) this.mergeServerConfig(resp.config);
    if (typeof resp.min_mem_start_gib === "number" && resp.min_mem_start_gib > 0) {
      this.serverCfg.min_mem_start_gib = resp.min_mem_start_gib;
    }
  }

  private async handleCommand(cmd: ClaimedCommand): Promise<void> {
    log("info", `command ${cmd.id} type=${cmd.type} received`);
    try {
      await this.client.ack(this.agentId!, this.token!, cmd.id, this.sessionId!);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.isSuperseded) throw new SupersededError();
        log("warn", `ack for ${cmd.id} rejected (HTTP ${err.status}) — skipping execution`);
        return;
      }
      log("warn", `ack for ${cmd.id} failed (network) — executing anyway`);
    }

    const result = await this.executor.execute(cmd);
    log(
      "info",
      `command ${cmd.id} finished status=${result.status}${result.error_reason ? ` reason=${result.error_reason}` : ""}`,
    );
    try {
      await this.client.result(this.agentId!, this.token!, cmd.id, this.sessionId!, result);
    } catch (err) {
      log(
        "error",
        `result for ${cmd.id} could not be delivered: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Fresh heartbeat immediately after execution so the server can verify
    // state-changing commands against a new snapshot.
    try {
      await this.sendHeartbeat();
    } catch (err) {
      if (err instanceof HttpError && err.isSuperseded) throw new SupersededError();
      log(
        "warn",
        `post-command heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ------------------------------------------------------------------- main

async function main(): Promise<void> {
  let cfg: BridgeConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[muse-bridge] FATAL: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const bridge = new Bridge(cfg);
  await bridge.run();
}

void main();
