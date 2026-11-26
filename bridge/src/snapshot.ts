import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import type { HostSnapshot } from "./types.js";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/**
 * Current VM boot ID. Read from /proc (both demo and real mode — a VM
 * replacement must be visible as a new boot). On non-Linux dev machines,
 * falls back to a persisted generated ID inside the bridge dir.
 */
export function readBootId(fallbackDir?: string): string {
  try {
    const id = readFileSync(BOOT_ID_PATH, "utf8").trim();
    if (id) return id;
  } catch {
    /* not on Linux / not readable — use fallback */
  }
  if (fallbackDir) {
    const file = join(fallbackDir, "dev-boot-id");
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    }
    const generated = `dev-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    try {
      mkdirSync(fallbackDir, { recursive: true });
      writeFileSync(file, generated + "\n", "utf8");
    } catch {
      /* read-only dir — return the ephemeral value anyway */
    }
    return generated;
  }
  return "unknown-boot";
}

/** Boot time as ISO 8601 UTC, from /proc/stat btime (fallback: now − uptime). */
export function readBootTimeIso(): string {
  try {
    const stat = readFileSync("/proc/stat", "utf8");
    const match = /^btime\s+(\d+)$/m.exec(stat);
    if (match) return new Date(Number.parseInt(match[1], 10) * 1000).toISOString();
  } catch {
    /* fall through */
  }
  try {
    const uptimeSec = Number.parseFloat(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (Number.isFinite(uptimeSec)) return new Date(Date.now() - uptimeSec * 1000).toISOString();
  } catch {
    /* fall through */
  }
  return new Date().toISOString();
}

/** MemAvailable from /proc/meminfo, in GiB (2 decimal places). */
export function readMemAvailableGiB(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
    if (match) {
      const gib = Number.parseInt(match[1], 10) / 1024 / 1024;
      return Math.round(gib * 100) / 100;
    }
  } catch {
    /* fall through */
  }
  return Math.round((freemem() / 1024 ** 3) * 100) / 100;
}

/** Real host snapshot (real mode, and boot identity in both modes). */
export function readHostSnapshot(fallbackDir?: string): HostSnapshot {
  return {
    boot_id: readBootId(fallbackDir),
    mem_available_gib: readMemAvailableGiB(),
  };
}
