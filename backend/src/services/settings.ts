// System settings: stored in the `system_settings` table, seeded with the
// contract defaults, and always read through here (never hardcoded in logic).

import type { PrismaClient } from '@prisma/client';

export const DEFAULT_SETTINGS: Record<string, number | string | boolean> = {
  heartbeat_interval_sec: 30,
  unreachable_missed_beats: 3,
  min_mem_start_gib: 5,
  min_hashrate_hs: 0.5,
  mem_warn_margin_gib: 1,
  no_share_warn_sec: 1800,
  pool_stall_sec: 7200,
  pairing_ttl_sec: 900,
  command_ttl_sec: 600,
  verify_window_sec: 120,
  // Pool API configuration (Phase 1: placeholder provider only).
  pool_provider: 'none',
  pool_api_base_url: '',
  pool_lookup_param: '',
  // Multi-channel alerts (Phase 2, CONTRACT-2 §4).
  alert_dead_after_sec: 600,
  alert_webhook_url: '',
  alert_webhook_enabled: false,
  alert_telegram_chat_id: '',
  alert_telegram_enabled: false,
  // Phase 3 (CONTRACT-3 §2/§4): automation master switch + retention windows
  // in days (0 = retention disabled for that set). The enrollment key
  // (CONTRACT-3 §8) is deliberately NOT a default/editable setting: it is a
  // generated secret managed by services/enrollment.ts.
  automation_enabled: true,
  retention_heartbeats_days: 30,
  retention_terminal_commands_days: 90,
  retention_alerts_days: 90,
  retention_pool_snapshots_days: 30,
};

/** Keys a dashboard user may update via PUT /api/settings. */
export const EDITABLE_SETTING_KEYS = new Set<string>([
  ...Object.keys(DEFAULT_SETTINGS),
  'pool_api_key', // write-only: stored, never returned by GET /api/settings
  'alert_telegram_bot_token', // write-only: stored, never returned by GET /api/settings
]);

const NUMERIC_KEYS = new Set<string>([
  'heartbeat_interval_sec',
  'unreachable_missed_beats',
  'min_mem_start_gib',
  'min_hashrate_hs',
  'mem_warn_margin_gib',
  'no_share_warn_sec',
  'pool_stall_sec',
  'pairing_ttl_sec',
  'command_ttl_sec',
  'verify_window_sec',
  'alert_dead_after_sec',
]);

const BOOLEAN_KEYS = new Set<string>([
  'alert_webhook_enabled',
  'alert_telegram_enabled',
  'automation_enabled',
]);

/** Numeric keys where 0 is meaningful (Phase 3 retention: 0 = disabled). */
const ZEROABLE_NUMERIC_KEYS = new Set<string>([
  'retention_heartbeats_days',
  'retention_terminal_commands_days',
  'retention_alerts_days',
  'retention_pool_snapshots_days',
]);

export interface Settings {
  heartbeat_interval_sec: number;
  unreachable_missed_beats: number;
  min_mem_start_gib: number;
  min_hashrate_hs: number;
  mem_warn_margin_gib: number;
  no_share_warn_sec: number;
  pool_stall_sec: number;
  pairing_ttl_sec: number;
  command_ttl_sec: number;
  verify_window_sec: number;
  pool_provider: string;
  pool_api_base_url: string;
  pool_lookup_param: string;
  pool_api_key_set: boolean;
  // Phase 2 alerts. The Telegram bot token itself is never exposed — only
  // the *_configured booleans below.
  alert_dead_after_sec: number;
  alert_webhook_url: string;
  alert_webhook_enabled: boolean;
  alert_webhook_configured: boolean;
  alert_telegram_chat_id: string;
  alert_telegram_enabled: boolean;
  alert_telegram_configured: boolean;
  // Phase 3.
  automation_enabled: boolean;
  retention_heartbeats_days: number;
  retention_terminal_commands_days: number;
  retention_alerts_days: number;
  retention_pool_snapshots_days: number;
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Insert any missing default settings. Idempotent; called on boot. */
export async function seedSettings(prisma: PrismaClient): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.systemSetting.upsert({
      where: { key },
      update: {},
      create: { key, value: value as never },
    });
  }
}

/** Read the full effective settings (DB values merged over defaults). */
export async function getSettings(prisma: PrismaClient): Promise<Settings> {
  const rows = await prisma.systemSetting.findMany();
  const map = new Map<string, unknown>(rows.map((r) => [r.key, r.value]));
  const get = (key: string) => (map.has(key) ? map.get(key) : DEFAULT_SETTINGS[key]);
  return {
    heartbeat_interval_sec: num(get('heartbeat_interval_sec'), 30),
    unreachable_missed_beats: num(get('unreachable_missed_beats'), 3),
    min_mem_start_gib: num(get('min_mem_start_gib'), 5),
    min_hashrate_hs: num(get('min_hashrate_hs'), 0.5),
    mem_warn_margin_gib: num(get('mem_warn_margin_gib'), 1),
    no_share_warn_sec: num(get('no_share_warn_sec'), 1800),
    pool_stall_sec: num(get('pool_stall_sec'), 7200),
    pairing_ttl_sec: num(get('pairing_ttl_sec'), 900),
    command_ttl_sec: num(get('command_ttl_sec'), 600),
    verify_window_sec: num(get('verify_window_sec'), 120),
    pool_provider: String(get('pool_provider') ?? 'none'),
    pool_api_base_url: String(get('pool_api_base_url') ?? ''),
    pool_lookup_param: String(get('pool_lookup_param') ?? ''),
    pool_api_key_set: typeof map.get('pool_api_key') === 'string' && (map.get('pool_api_key') as string).length > 0,
    alert_dead_after_sec: num(get('alert_dead_after_sec'), 600),
    alert_webhook_url: String(get('alert_webhook_url') ?? ''),
    alert_webhook_enabled: bool(get('alert_webhook_enabled'), false),
    alert_webhook_configured: nonEmptyString(map.get('alert_webhook_url') ?? get('alert_webhook_url')),
    alert_telegram_chat_id: String(get('alert_telegram_chat_id') ?? ''),
    alert_telegram_enabled: bool(get('alert_telegram_enabled'), false),
    alert_telegram_configured:
      nonEmptyString(map.get('alert_telegram_bot_token')) && nonEmptyString(map.get('alert_telegram_chat_id') ?? get('alert_telegram_chat_id')),
    automation_enabled: bool(get('automation_enabled'), true),
    retention_heartbeats_days: num(get('retention_heartbeats_days'), 30),
    retention_terminal_commands_days: num(get('retention_terminal_commands_days'), 90),
    retention_alerts_days: num(get('retention_alerts_days'), 90),
    retention_pool_snapshots_days: num(get('retention_pool_snapshots_days'), 30),
  };
}

/**
 * Read one raw setting value straight from the table (used for write-only
 * secrets such as the Telegram bot token, which getSettings never exposes).
 */
export async function getRawSetting(prisma: PrismaClient, key: string): Promise<unknown> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row?.value;
}

const POOL_KEYS = ['pool_provider', 'pool_api_base_url', 'pool_lookup_param'];

/**
 * Phase 5 (CONTRACT-5 B5; owner spec §2/§9): when the RESULTING provider is
 * 'bntpool', validate + normalize the pool fields of a patch before anything
 * is written. Returns the patch with normalized pool values substituted.
 * pool_api_key is never validated.
 */
async function normalizePoolPatch(
  prisma: PrismaClient,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!POOL_KEYS.some((k) => k in patch)) return patch;
  const current = await getSettings(prisma);
  const provider =
    typeof patch.pool_provider === 'string' ? patch.pool_provider : current.pool_provider;
  if (provider !== 'bntpool') return patch;

  const rawBase =
    typeof patch.pool_api_base_url === 'string' ? patch.pool_api_base_url : current.pool_api_base_url;
  const rawLookup =
    typeof patch.pool_lookup_param === 'string' ? patch.pool_lookup_param : current.pool_lookup_param;

  const baseUrl = rawBase.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('pool_api_base_url is required when pool_provider is bntpool');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('pool_api_base_url must be a valid https URL without a query string');
  }
  if (parsed.protocol !== 'https:' || parsed.search !== '') {
    throw new Error('pool_api_base_url must be a valid https URL without a query string');
  }

  const lookupParam = rawLookup.trim();
  if (!lookupParam) {
    throw new Error('pool_lookup_param is required when pool_provider is bntpool');
  }
  if (/\s/.test(lookupParam) || /[/?#]/.test(lookupParam)) {
    throw new Error('pool_lookup_param must not contain spaces or the characters /, ?, #');
  }

  return { ...patch, pool_api_base_url: baseUrl, pool_lookup_param: lookupParam };
}

/**
 * Validate + apply a settings update. Returns the list of updated keys.
 * Throws Error with a client-facing message on invalid key/value.
 */
export async function updateSettings(
  prisma: PrismaClient,
  patchInput: Record<string, unknown>,
): Promise<string[]> {
  const patch = await normalizePoolPatch(prisma, patchInput);
  const updated: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE_SETTING_KEYS.has(key)) {
      throw new Error(`Unknown setting key: ${key}`);
    }
    if (ZEROABLE_NUMERIC_KEYS.has(key)) {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw new Error(`Setting ${key} must be a non-negative integer (0 = nonaktif)`);
      }
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value: n as never },
        create: { key, value: n as never },
      });
    } else if (NUMERIC_KEYS.has(key)) {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Setting ${key} must be a positive number`);
      }
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value: n as never },
        create: { key, value: n as never },
      });
    } else if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') {
        throw new Error(`Setting ${key} must be a boolean`);
      }
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value: value as never },
        create: { key, value: value as never },
      });
    } else {
      if (typeof value !== 'string') {
        throw new Error(`Setting ${key} must be a string`);
      }
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value: value as never },
        create: { key, value: value as never },
      });
    }
    updated.push(key);
  }
  return updated;
}
