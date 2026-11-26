import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { BridgeMode } from "./types.js";

export const DEFAULT_CAPABILITIES = [
  "miner.status",
  "miner.run",
  "miner.restart",
  "miner.reinstall",
  "miner.hold",
  "miner.unhold",
];

export interface BridgeConfig {
  /** Base URL of the Muse Management Control server, e.g. https://control.example.com */
  serverUrl: string;
  pairingCode?: string;
  /** Zero-touch self-enrollment key (alternative to a pairing code, first registration only). */
  enrollmentKey?: string;
  agentName: string;
  workerName?: string;
  mode: BridgeMode;
  /** systemd unit name of the miner (real mode). Empty = not configured. */
  minerUnit: string;
  /** Optional local HTTP endpoint serving miner-process statistics as JSON (CONTRACT-6). */
  minerStatsUrl?: string;
  reinstallScript?: string;
  /** Directory holding identity.json, token, hold flag, config.json. */
  bridgeDir: string;
  capabilities: string[];
  /** Demo mode: simulated MemAvailable. */
  demoMemGib: number;
  demoMinerStart: "active" | "inactive";
  demoSeed: number;
}

export class ConfigError extends Error {}

interface FileConfig {
  server_url?: string;
  pairing_code?: string;
  enrollment_key?: string;
  agent_name?: string;
  worker_name?: string;
  mode?: string;
  miner_unit?: string;
  miner_stats_url?: string;
  reinstall_script?: string;
  capabilities?: string[];
}

function readFileConfig(bridgeDir: string): FileConfig {
  const path = join(bridgeDir, "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch {
    return {};
  }
}

function parseFloatOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Load bridge configuration. Environment variables win over
 * `<bridgeDir>/config.json`, which wins over defaults.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): BridgeConfig {
  const bridgeDir =
    env.MUSE_BRIDGE_DIR && env.MUSE_BRIDGE_DIR !== ""
      ? env.MUSE_BRIDGE_DIR
      : join(homedir(), "workspace", "muse-bridge");

  const file = readFileConfig(bridgeDir);

  const serverUrlRaw = env.MUSE_SERVER_URL || file.server_url || "";
  const serverUrl = serverUrlRaw.replace(/\/+$/, "");
  if (!serverUrl) {
    throw new ConfigError(
      "MUSE_SERVER_URL is required (env or config.json server_url in the bridge dir).",
    );
  }

  const modeRaw = (env.MUSE_BRIDGE_MODE || file.mode || "demo").toLowerCase();
  const mode: BridgeMode = modeRaw === "real" ? "real" : "demo";

  const capabilitiesEnv = env.MUSE_CAPABILITIES
    ? env.MUSE_CAPABILITIES.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  return {
    serverUrl,
    pairingCode: env.MUSE_PAIRING_CODE || file.pairing_code || undefined,
    enrollmentKey: env.MUSE_ENROLLMENT_KEY || file.enrollment_key || undefined,
    agentName: env.MUSE_AGENT_NAME || file.agent_name || hostname(),
    workerName: env.MUSE_WORKER_NAME || file.worker_name || undefined,
    mode,
    minerUnit: env.MUSE_MINER_UNIT ?? file.miner_unit ?? "",
    minerStatsUrl: env.MUSE_MINER_STATS_URL || file.miner_stats_url || undefined,
    reinstallScript: env.MUSE_REINSTALL_SCRIPT || file.reinstall_script || undefined,
    bridgeDir,
    capabilities: capabilitiesEnv ?? file.capabilities ?? [...DEFAULT_CAPABILITIES],
    demoMemGib: parseFloatOr(env.DEMO_MEM_GIB, 6.8),
    demoMinerStart: env.DEMO_MINER_START === "inactive" ? "inactive" : "active",
    demoSeed: Math.trunc(parseFloatOr(env.DEMO_SEED, 1337)),
  };
}
