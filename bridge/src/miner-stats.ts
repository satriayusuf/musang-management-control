/**
 * Optional miner-process statistics source (CONTRACT-6).
 *
 * The real bridge can only see the miner's systemd service state; the live
 * numbers (hashrate, shares, job) live inside the miner process. When
 * MUSE_MINER_STATS_URL points at a local HTTP endpoint that serves those
 * numbers as JSON, the bridge fetches and merges them into the snapshot.
 * Parsing is defensive: unknown shapes yield nulls, never invented numbers,
 * and any failure simply leaves the snapshot as it was.
 */

export interface MinerStats {
  hashrate_hs: number | null;
  shares_local: number | null;
  accepted_shares: number | null;
  rejected_shares: number | null;
  last_share_at: string | null;
  job_height: number | null;
  difficulty: number | null;
}

const EMPTY: MinerStats = {
  hashrate_hs: null,
  shares_local: null,
  accepted_shares: null,
  rejected_shares: null,
  last_share_at: null,
  job_height: null,
  difficulty: null,
};

const CONTAINER_KEYS = ["data", "result", "miner", "stats", "status"] as const;

const ALIASES: Record<keyof MinerStats, readonly string[]> = {
  hashrate_hs: ["hashrate_hs", "hashrate", "hash_rate", "speed_hs", "total_hashrate"],
  shares_local: ["shares_local", "shares", "shares_session"],
  accepted_shares: ["accepted_shares", "accepted", "shares_accepted"],
  rejected_shares: ["rejected_shares", "rejected", "shares_rejected"],
  last_share_at: ["last_share_at", "last_share"],
  job_height: ["job_height", "height"],
  difficulty: ["difficulty", "diff"],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Unwrap one container level ({data: {...}}, {result: {...}}, …) if present. */
function unwrap(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  for (const key of CONTAINER_KEYS) {
    if (isRecord(payload[key])) return payload[key] as Record<string, unknown>;
  }
  return payload;
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** Coerce a number or numeric string ("1.32", "1.32 H/s") to a finite number. */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const m = v.trim().match(/^-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number.parseFloat(m[0]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toInt(v: unknown): number | null {
  const n = toNumber(v);
  return n === null ? null : Math.trunc(n);
}

/** Epoch seconds / epoch milliseconds / ISO string → ISO string. */
function toIsoTime(v: unknown): string | null {
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
    const n = toNumber(v);
    return n === null ? null : toIsoTime(n);
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

export function parseMinerStats(payload: unknown): MinerStats {
  const obj = unwrap(payload);
  if (!obj) return { ...EMPTY };
  return {
    hashrate_hs: toNumber(pick(obj, ALIASES.hashrate_hs)),
    shares_local: toInt(pick(obj, ALIASES.shares_local)),
    accepted_shares: toInt(pick(obj, ALIASES.accepted_shares)),
    rejected_shares: toInt(pick(obj, ALIASES.rejected_shares)),
    last_share_at: toIsoTime(pick(obj, ALIASES.last_share_at)),
    job_height: toInt(pick(obj, ALIASES.job_height)),
    difficulty: toNumber(pick(obj, ALIASES.difficulty)),
  };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 2500;

/**
 * Fetch + parse the stats endpoint. Returns null on ANY failure (network,
 * HTTP status, oversize, invalid JSON) — the caller keeps its old snapshot.
 */
export async function fetchMinerStats(
  url: string,
  fetchFn: FetchFn = fetch,
): Promise<MinerStats | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "muse-bridge/1.0.0", accept: "application/json" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_BYTES) return null;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const stats = parseMinerStats(json);
    return Object.values(stats).some((v) => v !== null) ? stats : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
