/**
 * Self-update for the bridge.update command (CONTRACT-10).
 *
 * The bridge refreshes two things from its OWN configured server (URLs
 * are derived from serverUrl only — a command can never point the
 * bridge at another host):
 *
 * 1. The bundle `<bridgeDir>/bridge.cjs`: downloaded from
 *    `{serverUrl}/bridge.cjs`, SHA-256 compared with the installed
 *    file. When different, the download is syntax-checked
 *    (`node --check`), the current bundle is backed up to
 *    `bridge.cjs.bak`, and the new one is installed atomically
 *    (temp file + rename). The caller restarts the process after the
 *    command result has been delivered (systemd Restart=always brings
 *    it back on the new bundle).
 * 2. The runtime instruction document: `{serverUrl}/agent.md` is
 *    stored at `<bridgeDir>/agent.md` when it differs, so the newest
 *    instructions are present on the VM for the runtime to re-apply.
 *    Best-effort: a failure here is reported, never fatal.
 *
 * Downloads are defensive: 15 s timeout, 8 MiB cap, no auth headers.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FetchFn = typeof fetch;

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function download(url: string, fetchFn: FetchFn): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "muse-bridge-updater/1.1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} dari ${url}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) throw new Error(`Unduhan kosong dari ${url}`);
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`Unduhan terlalu besar dari ${url}`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/** Default syntax check: `node --check <file>` (exit 0 = valid). */
export function nodeSyntaxCheck(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("node", ["--check", file], (err: Error | null) => {
      if (err) reject(new Error(`node --check gagal untuk bundle baru: ${err.message}`));
      else resolve();
    });
  });
}

export interface BridgeUpdateDeps {
  serverUrl: string;
  bridgeDir: string;
  fetchFn?: FetchFn;
  syntaxCheck?: (file: string) => Promise<void>;
}

export interface BridgeUpdateOutcome {
  /** True when a different bundle was installed (restart required). */
  bundleUpdated: boolean;
  /** SHA-256 of the previously installed bundle, null when none existed. */
  bundleFromSha: string | null;
  /** SHA-256 of the bundle now installed. */
  bundleToSha: string;
  /** True when the local agent.md copy changed. */
  agentMdUpdated: boolean;
  /** Non-fatal agent.md problem, when its refresh failed. */
  agentMdError?: string;
}

function readIfExists(file: string): Uint8Array | null {
  try {
    return existsSync(file) ? readFileSync(file) : null;
  } catch {
    return null;
  }
}

export async function performBridgeUpdate(deps: BridgeUpdateDeps): Promise<BridgeUpdateOutcome> {
  const fetchFn = deps.fetchFn ?? fetch;
  const syntaxCheck = deps.syntaxCheck ?? nodeSyntaxCheck;
  const base = deps.serverUrl.replace(/\/+$/, "");
  const bundlePath = join(deps.bridgeDir, "bridge.cjs");

  // --- 1. Bundle -----------------------------------------------------
  const remote = await download(`${base}/bridge.cjs`, fetchFn);
  const remoteSha = sha256Hex(remote);
  const local = readIfExists(bundlePath);
  const localSha = local ? sha256Hex(local) : null;

  let bundleUpdated = false;
  if (remoteSha !== localSha) {
    // The temp name MUST end in .cjs: `node --check` refuses files whose
    // extension it cannot classify (found live in the Phase 10 E2E).
    const tmpPath = join(deps.bridgeDir, ".bridge.cjs.download.cjs");
    writeFileSync(tmpPath, remote);
    try {
      await syntaxCheck(tmpPath); // throws → command fails, nothing installed
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best effort cleanup */
      }
      throw err;
    }
    if (local) copyFileSync(bundlePath, join(deps.bridgeDir, "bridge.cjs.bak"));
    renameSync(tmpPath, bundlePath);
    bundleUpdated = true;
  }

  // --- 2. agent.md copy (best-effort) --------------------------------
  let agentMdUpdated = false;
  let agentMdError: string | undefined;
  try {
    const md = await download(`${base}/agent.md`, fetchFn);
    const mdPath = join(deps.bridgeDir, "agent.md");
    const localMd = readIfExists(mdPath);
    if (!localMd || sha256Hex(localMd) !== sha256Hex(md)) {
      writeFileSync(mdPath, md);
      agentMdUpdated = true;
    }
  } catch (err) {
    agentMdError = err instanceof Error ? err.message : String(err);
  }

  return { bundleUpdated, bundleFromSha: localSha, bundleToSha: remoteSha, agentMdUpdated, agentMdError };
}

/** Short human summary of an update outcome (Indonesian, for the command result). */
export function summarizeUpdate(o: BridgeUpdateOutcome): string {
  const short = (sha: string | null) => (sha ? sha.slice(0, 12) : "—");
  const bundle = o.bundleUpdated
    ? `Bundle bridge DIPERBARUI: sha ${short(o.bundleFromSha)} → ${short(o.bundleToSha)}; bridge restart sendiri setelah hasil ini terkirim.`
    : `Bundle bridge sudah versi terbaru (sha ${short(o.bundleToSha)}).`;
  const md = o.agentMdError
    ? `Salinan agent.md gagal diperbarui: ${o.agentMdError}.`
    : o.agentMdUpdated
      ? "Salinan agent.md di folder bridge diperbarui ke versi terbaru."
      : "Salinan agent.md sudah terbaru.";
  return `${bundle} ${md}`;
}
