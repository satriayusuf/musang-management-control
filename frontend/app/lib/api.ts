// Klien API untuk dashboard Muse Management Control.
// JWT disimpan di localStorage; 401 → bersihkan sesi dan arahkan ke /login.

export const TOKEN_KEY = 'mmc_token'

export function getToken(): string | null {
  if (import.meta.server) return null
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* abaikan */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* abaikan */
  }
}

let cachedApiBase: string | null = null

export function apiBase(): string {
  if (cachedApiBase) return cachedApiBase
  const cfg = useRuntimeConfig()
  cachedApiBase = (cfg.public.apiBase as string) || '/api'
  return cachedApiBase
}

/**
 * URL WebSocket diturunkan dari apiBase:
 * - apiBase absolut (http://host:3001/api) → ws://host:3001/ws
 * - apiBase relatif (/api) → ws(s)://<origin saat ini>/ws
 * JWT dikirim sebagai query ?token= sesuai kontrak.
 */
export function wsUrl(token: string): string {
  const base = apiBase()
  let origin: string
  let protocol: string
  if (/^https?:\/\//i.test(base)) {
    const u = new URL(base)
    origin = u.origin
    protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  } else {
    origin = window.location.origin
    protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  }
  return `${protocol}//${origin.replace(/^\w+:\/\//, '')}/ws?token=${encodeURIComponent(token)}`
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.message === 'string') return b.message
    if (typeof b.error === 'string') return b.error
    if (typeof b.reason === 'string') return b.reason
  }
  return fallback
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Record<string, string | number | undefined | null> } = {},
): Promise<T> {
  const base = apiBase()
  let url = `${base}${path}`
  if (opts.query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
    }
    const s = qs.toString()
    if (s) url += `?${s}`
  }
  const token = getToken()
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  if (res.status === 401) {
    clearToken()
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login'
    }
    throw new ApiError(401, 'Sesi berakhir. Silakan masuk kembali.')
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, extractErrorMessage(data, `Permintaan gagal (${res.status}).`), data)
  }
  return data as T
}

/** Normalisasi respon daftar berpaginasi dari berbagai bentuk yang mungkin dikembalikan backend. */
export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export function normalizePage<T>(res: unknown, fallbackPage = 1, fallbackSize = 20): Page<T> {
  if (Array.isArray(res)) {
    return { items: res as T[], total: res.length, page: fallbackPage, pageSize: fallbackSize }
  }
  if (res && typeof res === 'object') {
    const r = res as Record<string, unknown>
    const items = (r.items ?? r.data ?? r.results ?? []) as T[]
    const pag = (r.pagination ?? {}) as Record<string, unknown>
    const total = Number(r.total ?? pag.total ?? items.length) || 0
    const page = Number(r.page ?? pag.page ?? fallbackPage) || fallbackPage
    const pageSize = Number(r.page_size ?? r.pageSize ?? pag.page_size ?? pag.pageSize ?? fallbackSize) || fallbackSize
    return { items, total, page, pageSize }
  }
  return { items: [], total: 0, page: fallbackPage, pageSize: fallbackSize }
}

/** Ambil field bersarang secara aman: pick(obj, 'a', 'b') mencoba beberapa nama field. */
export function pick<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const o = obj as Record<string, unknown>
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k] as T
  }
  return undefined
}

// ---------- Tipe data (sesuai kontrak) ----------

/** Blok runtime Muse (CONTRACT-7 §6). Nilai token tidak pernah tampil — hanya status diterbitkan + laporan terakhir. */
export interface RuntimeStateInfo {
  token_issued: boolean
  token_issued_at?: string | null
  last_contact_at?: string | null
  last_event_type?: string | null
  last_event_at?: string | null
  last_transition_type?: string | null
  last_transition_at?: string | null
  transition_reason?: string | null
  boot_time?: string | null
  snapshot?: {
    at?: string | null
    hashrate_hs?: number | null
    shares_local?: number | null
    pool_accepted?: number | null
    pool_last_share_at?: string | null
    mem_available_gib?: number | null
  } | null
}

export interface AgentSummary {
  id: string
  name: string
  created_at?: string
  worker_name?: string | null
  capabilities?: string[]
  bridge_version?: string | null
  status?: string
  /** Fase 3 (§8): "self" untuk agent yang mendaftar mandiri lewat agent.md; "pairing" untuk jalur kode pairing. */
  enrolled_via?: string | null
  first_registered_at?: string
  last_seen_at?: string | null
  replacement_count?: number
  current_session_id?: string | null
  revoked_at?: string | null
  current_session?: SessionInfo | null
  worker?: WorkerSummary | null
  /** CONTRACT-7: status gabungan (JALAN/PULIH/MATI/TAK_TERJANGKAU) + blok runtime. */
  combined_status?: string | null
  combined_status_reason?: string | null
  runtime?: RuntimeStateInfo | null
  [key: string]: unknown
}

export interface SessionInfo {
  id: string
  agent_id?: string
  session_no?: number
  boot_id?: string
  boot_time?: string
  started_at?: string
  ended_at?: string | null
  end_reason?: string | null
  [key: string]: unknown
}

/**
 * Data pool pada objek worker (CONTRACT-5 B6). null bila provider bukan
 * bntpool atau agent tidak punya worker. state 'unknown' berarti cek pool
 * sedang tidak tersedia — field lain berisi data sukses terakhir yang diketahui.
 */
export interface WorkerPoolInfo {
  state: 'ok' | 'unknown'
  found: boolean
  hashrate: number | null
  accepted: number | null
  rejected: number | null
  last_share_at: string | null
  fetched_at: string | null
  fetch_error: string | null
}

export interface WorkerSummary {
  id: string
  agent_id?: string
  name: string
  status?: string
  status_reason?: string | null
  /** CONTRACT-5 B6: snapshot pool per worker; null = tidak ada blok pool. */
  pool?: WorkerPoolInfo | null
  /** CONTRACT-7: status gabungan server (runtime > bridge > pool). */
  combined_status?: string | null
  combined_status_reason?: string | null
  [key: string]: unknown
}

export interface WorkerInfo extends WorkerSummary {
  pool_address?: string | null
  status_since?: string
  last_share_at?: string | null
  last_local_share_at?: string | null
  hashrate_hs?: number
  accepted_shares?: number
  rejected_shares?: number
  shares_local?: number
  job_height?: number
  difficulty?: number
  miner_service_state?: string
  last_recovery_at?: string | null
  hold_until?: string | null
  /** Fase 2: status tahan auto-recovery dari snapshot heartbeat bridge. */
  hold_active?: boolean
  mem_available_gib?: number | null
  agent?: AgentSummary | null
  [key: string]: unknown
}

export interface CommandInfo {
  id: string
  agent_id: string
  worker_id?: string | null
  type: string
  payload?: Record<string, unknown> | null
  idempotency_key?: string
  status: string
  requested_by?: string
  created_at: string
  sent_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  expires_at?: string | null
  result?: unknown
  error_reason?: string | null
  /** Fase 2: template asal perintah (bila dibuat dari template). */
  template_id?: string | null
  /** Fase 2: batch broadcast asal perintah (bila dibuat lewat broadcast). */
  batch_id?: string | null
  /** Fase 3: sumber perintah — manual | automation | schedule. */
  source?: string
  rule_id?: string | null
  schedule_id?: string | null
  [key: string]: unknown
}

export interface EventInfo {
  id: string
  agent_id?: string | null
  worker_id?: string | null
  type: string
  description?: string | null
  metadata?: Record<string, unknown> | null
  created_at: string
  [key: string]: unknown
}

export interface OverviewData {
  agents: { total: number; online: number; working: number; idle: number; warning: number; unreachable: number }
  miners: { total: number; healthy: number; dead: number }
  active_commands: number
  worker_status_distribution: Record<string, number>
  recent_events: EventInfo[]
  active_alerts: AlertInfo[]
  pool_configured?: boolean
}

export interface AlertInfo {
  agent_name?: string
  worker_name?: string
  agent_id?: string
  worker_id?: string
  type: string
  reason?: string
  at?: string
  action?: string
  [key: string]: unknown
}

// ---------- Tipe Fase 2 ----------

export interface CommandTemplateInfo {
  id: string
  name: string
  type: string
  payload?: Record<string, unknown> | null
  description?: string | null
  sensitive?: boolean
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface BroadcastCreatedItem {
  agent_id: string
  command_id: string
}

export interface BroadcastSkippedItem {
  agent_id: string
  reason: string
}

export interface BroadcastResult {
  batch_id: string
  created: BroadcastCreatedItem[]
  skipped: BroadcastSkippedItem[]
  [key: string]: unknown
}

export interface BatchInfo {
  id: string
  type: string
  template_id?: string | null
  payload?: Record<string, unknown> | null
  requested_by?: string
  total_count?: number
  created_count?: number
  skipped_count?: number
  created_at: string
  /** Jumlah perintah per status — nama field dinormalisasi oleh batchStatusCounts(). */
  status_counts?: Record<string, number>
  counts?: Record<string, number>
  command_counts?: Record<string, number>
  commands?: CommandInfo[]
  [key: string]: unknown
}

/** Ambil jumlah per status perintah dari batch, apa pun bentuk field yang dikembalikan server. */
export function batchStatusCounts(batch: BatchInfo | Record<string, unknown>): Record<string, number> {
  const b = batch as Record<string, unknown>
  for (const key of ['status_counts', 'counts', 'command_counts']) {
    const v = b[key]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, number> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const n = Number(val)
        if (!Number.isNaN(n)) out[k.toUpperCase()] = n
      }
      if (Object.keys(out).length > 0) return out
    }
  }
  // Bentuk datar: field queued/sent/running/... langsung pada objek batch.
  const flat: Record<string, number> = {}
  for (const s of ['QUEUED', 'SENT', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'EXPIRED']) {
    const v = b[s] ?? b[s.toLowerCase()]
    if (typeof v === 'number') flat[s] = v
  }
  if (Object.keys(flat).length > 0) return flat
  // Terakhir: hitung dari daftar perintah bila disertakan.
  const cmds = b.commands
  if (Array.isArray(cmds)) {
    const out: Record<string, number> = {}
    for (const c of cmds as CommandInfo[]) {
      const s = (c.status ?? '').toUpperCase()
      if (s) out[s] = (out[s] ?? 0) + 1
    }
    return out
  }
  return {}
}

export interface AlertDeliveryInfo {
  id?: string
  notification_id?: string
  channel: string
  status: string
  error?: string | null
  at?: string
  [key: string]: unknown
}

export interface AlertNotificationInfo {
  id: string
  condition: string
  agent_id?: string | null
  worker_id?: string | null
  agent_name?: string | null
  worker_name?: string | null
  title: string
  body?: string | null
  created_at: string
  deliveries?: AlertDeliveryInfo[]
  [key: string]: unknown
}

// ---------- Tipe Fase 3 ----------

/** Fase 8 (CONTRACT-8): pertanyaan broadcast ke agent. */
export interface QuestionBroadcastSummary {
  total: number
  answered: number
  queued: number
  expired: number
}

/** Fase 9 (CONTRACT-9): pertanyaan hanya-baca atau instruksi yang dieksekusi. */
export type BroadcastKind = 'question' | 'instruction'

export interface QuestionBroadcastListItem {
  broadcast_id: string
  kind: BroadcastKind
  question: string
  asked_by: string
  asked_at: string
  summary: QuestionBroadcastSummary
}

export interface QuestionItem {
  id: string
  agent_id: string
  agent_name?: string
  broadcast_id: string
  kind: BroadcastKind
  question: string
  asked_by: string
  asked_at: string
  status: string
  answer: string | null
  answered_at: string | null
}

export interface QuestionBroadcastDetail {
  broadcast_id: string
  kind: BroadcastKind
  question: string
  asked_by: string
  asked_at: string
  summary: QuestionBroadcastSummary
  items: QuestionItem[]
}

export type UserRole = 'ADMIN' | 'OPERATOR' | 'VIEWER'

export interface UserInfo {
  id: string
  email: string
  role: string
  disabled?: boolean
  disabled_at?: string | null
  created_at?: string
  [key: string]: unknown
}

export interface RuleCondition {
  kind: 'worker_status' | 'agent_unreachable' | string
  status?: string
  for_sec: number
}

export interface RuleAction {
  type?: string
  template_id?: string | null
}

/** Target aturan/jadwal ternormalisasi untuk UI. */
export type TargetSelection = { mode: 'all' } | { mode: 'list'; ids: string[] }

function parseJsonField(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* abaikan */
    }
  }
  return {}
}

/** Normalisasi field target ({agent_ids: [] | "all"} | "all" | [ids]) ke bentuk UI. */
export function normalizeTarget(raw: unknown): TargetSelection {
  if (raw === 'all') return { mode: 'all' }
  if (Array.isArray(raw)) return { mode: 'list', ids: raw.map(String) }
  const obj = parseJsonField(raw)
  const ids = obj.agent_ids
  if (ids === 'all') return { mode: 'all' }
  if (Array.isArray(ids)) return { mode: 'list', ids: ids.map(String) }
  return { mode: 'all' }
}

/** Bentuk target sesuai CONTRACT-3 untuk dikirim ke server. */
export function denormalizeTarget(sel: TargetSelection): { agent_ids: string[] | 'all' } {
  return sel.mode === 'all' ? { agent_ids: 'all' } : { agent_ids: [...sel.ids] }
}

export interface AutomationRuleInfo {
  id: string
  name: string
  enabled: boolean
  condition: RuleCondition
  action: RuleAction
  target: TargetSelection
  cooldown_sec: number
  max_per_day: number
  last_fired_at?: string | null
  fire_count_today?: number
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export function normalizeRule(raw: Record<string, unknown>): AutomationRuleInfo {
  const cond = parseJsonField(raw.condition)
  const act = parseJsonField(raw.action)
  return {
    ...(raw as AutomationRuleInfo),
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    enabled: raw.enabled === true || raw.enabled === 'true' || raw.enabled === 1,
    condition: {
      kind: String(cond.kind ?? 'worker_status'),
      status: typeof cond.status === 'string' ? cond.status : undefined,
      for_sec: Number(cond.for_sec ?? cond.forSec ?? 0) || 0,
    },
    action: {
      type: typeof act.type === 'string' ? act.type : undefined,
      template_id: (act.template_id as string | null | undefined) ?? null,
    },
    target: normalizeTarget(raw.target),
    cooldown_sec: Number(raw.cooldown_sec ?? 3600) || 0,
    max_per_day: Number(raw.max_per_day ?? 5) || 0,
    last_fired_at: (raw.last_fired_at as string | null | undefined) ?? null,
    fire_count_today: Number(raw.fire_count_today ?? 0) || 0,
  }
}

export interface ScheduleInfo {
  id: string
  name: string
  enabled: boolean
  cron: string
  action: RuleAction
  target: TargetSelection
  broadcast: boolean
  next_run_at?: string | null
  last_run_at?: string | null
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export function normalizeSchedule(raw: Record<string, unknown>): ScheduleInfo {
  const act = parseJsonField(raw.action)
  return {
    ...(raw as ScheduleInfo),
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    enabled: raw.enabled === true || raw.enabled === 'true' || raw.enabled === 1,
    cron: String(raw.cron ?? ''),
    action: {
      type: typeof act.type === 'string' ? act.type : undefined,
      template_id: (act.template_id as string | null | undefined) ?? null,
    },
    target: normalizeTarget(raw.target),
    broadcast: raw.broadcast === true || raw.broadcast === 'true' || raw.broadcast === 1,
    next_run_at: (raw.next_run_at as string | null | undefined) ?? null,
    last_run_at: (raw.last_run_at as string | null | undefined) ?? null,
  }
}

export interface RetentionRunResult {
  heartbeats: number
  commands: number
  alerts: number
  pool_snapshots: number
  [key: string]: unknown
}

// ---------- Tipe CONTRACT-5: tes fetch pool saat simpan pengaturan ----------

/** Satu baris hasil tes fetch pool per agent ber-worker (CONTRACT-5 B5). */
export interface PoolTestResultItem {
  agent_id: string
  agent_name: string
  worker_name: string
  outcome: 'found' | 'not_found'
  pool_last_share_at?: string
  pool_hashrate?: number
}

/**
 * Hasil tes fetch yang menyertai respons simpan pengaturan bila provider
 * bntpool. fetch_ok=false berarti tes gagal — penyimpanan sendiri tetap
 * berhasil dan hasil ini ditampilkan sebagai peringatan.
 */
export interface PoolTestResult {
  fetch_ok: boolean
  error?: string
  results: PoolTestResultItem[]
}

export interface SettingsUpdateResponse {
  pool_test?: PoolTestResult
  [key: string]: unknown
}

/** Baca peran dari payload JWT (klaim `role`, CONTRACT-3 §1) tanpa verifikasi — hanya untuk tampilan. */
export function decodeJwtRole(token: string | null): string {
  if (!token) return ''
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return ''
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
    const payload = JSON.parse(json) as Record<string, unknown>
    return typeof payload.role === 'string' ? payload.role.toUpperCase() : ''
  } catch {
    return ''
  }
}

// ---------- Endpoint helpers ----------

export const api = {
  async login(email: string, password: string): Promise<{ token: string }> {
    return apiFetch<{ token: string }>('/auth/login', { method: 'POST', body: { email, password } })
  },
  async me(): Promise<{ email: string; role: string }> {
    const res = await apiFetch<Record<string, unknown>>('/auth/me')
    const user = (res.user ?? {}) as Record<string, unknown>
    const email = (res.email as string) ?? (user.email as string) ?? ''
    const roleRaw = (res.role as string) ?? (user.role as string) ?? ''
    return { email, role: typeof roleRaw === 'string' ? roleRaw.toUpperCase() : '' }
  },
  async overview(): Promise<OverviewData> {
    return apiFetch<OverviewData>('/dashboard/overview')
  },
  async listAgents(params: {
    search?: string
    search_by?: string
    status?: string
    page?: number
    page_size?: number
    sort?: string
  } = {}): Promise<Page<AgentSummary>> {
    const res = await apiFetch('/agents', { query: { ...params, sort: params.sort ?? 'last_seen' } })
    return normalizePage<AgentSummary>(res, params.page ?? 1, params.page_size ?? 20)
  },
  async getAgent(id: string): Promise<Record<string, unknown>> {
    return apiFetch<Record<string, unknown>>(`/agents/${id}`)
  },
  async createPairing(plannedName: string): Promise<{ pairing_code: string; expires_at: string }> {
    return apiFetch('/agents/pairing', { method: 'POST', body: { planned_name: plannedName } })
  },
  async revokeAgent(id: string): Promise<unknown> {
    return apiFetch(`/agents/${id}/revoke`, { method: 'POST' })
  },
  async deleteAgent(id: string): Promise<unknown> {
    return apiFetch(`/agents/${id}`, { method: 'DELETE' })
  },
  async listWorkers(): Promise<{
    items: WorkerInfo[];
    poolConfigured: boolean | null;
    poolTotals: { hashrate: number; worker_count: number; fetched_at: string } | null;
  }> {
    const res = await apiFetch<unknown>('/workers')
    const page = normalizePage<WorkerInfo>(res, 1, 500)
    let poolConfigured: boolean | null = null
    let poolTotals: { hashrate: number; worker_count: number; fetched_at: string } | null = null
    if (res && typeof res === 'object' && !Array.isArray(res)) {
      const pc = (res as Record<string, unknown>).pool_configured
      if (typeof pc === 'boolean') poolConfigured = pc
      const pt = (res as Record<string, unknown>).pool_totals
      if (pt && typeof pt === 'object' && typeof (pt as Record<string, unknown>).hashrate === 'number') {
        const t = pt as Record<string, unknown>
        poolTotals = {
          hashrate: t.hashrate as number,
          worker_count: typeof t.worker_count === 'number' ? t.worker_count : 0,
          fetched_at: typeof t.fetched_at === 'string' ? t.fetched_at : '',
        }
      }
    }
    return { items: page.items, poolConfigured, poolTotals }
  },
  async getWorker(id: string): Promise<Record<string, unknown>> {
    return apiFetch<Record<string, unknown>>(`/workers/${id}`)
  },
  async createWorkerCommand(
    workerId: string,
    body: {
      type: string
      payload?: Record<string, unknown>
      idempotency_key: string
      confirm?: boolean
      template_id?: string
    },
  ): Promise<CommandInfo> {
    return apiFetch<CommandInfo>(`/workers/${workerId}/commands`, { method: 'POST', body })
  },
  async listCommands(params: {
    agent_id?: string
    status?: string
    type?: string
    page?: number
    page_size?: number
  } = {}): Promise<Page<CommandInfo>> {
    const res = await apiFetch('/commands', { query: params })
    return normalizePage<CommandInfo>(res, params.page ?? 1, params.page_size ?? 20)
  },
  async listEvents(params: {
    agent_id?: string
    worker_id?: string
    type?: string
    from?: string
    to?: string
    outcome?: string
    page?: number
    page_size?: number
  } = {}): Promise<Page<EventInfo>> {
    const res = await apiFetch('/events', { query: params })
    return normalizePage<EventInfo>(res, params.page ?? 1, params.page_size ?? 20)
  },
  async analytics(params: {
    range: string
    from?: string
    to?: string
    agent_id?: string
    worker_id?: string
  }): Promise<Record<string, unknown>> {
    return apiFetch<Record<string, unknown>>('/analytics', { query: params })
  },
  async getSettings(): Promise<Record<string, unknown>> {
    const res = await apiFetch<unknown>('/settings')
    if (res && typeof res === 'object') {
      const r = res as Record<string, unknown>
      if (Array.isArray(r)) {
        const out: Record<string, unknown> = {}
        for (const row of r as Record<string, unknown>[]) {
          if (row && typeof row.key === 'string') out[row.key] = row.value
        }
        return out
      }
      if (r.settings && typeof r.settings === 'object') return r.settings as Record<string, unknown>
      return r
    }
    return {}
  },
  async updateSettings(values: Record<string, unknown>): Promise<SettingsUpdateResponse> {
    return apiFetch<SettingsUpdateResponse>('/settings', { method: 'PUT', body: values })
  },

  // ---------- Fase 2: template perintah ----------
  async listTemplates(): Promise<CommandTemplateInfo[]> {
    const res = await apiFetch<unknown>('/command-templates')
    return normalizePage<CommandTemplateInfo>(res, 1, 500).items
  },
  async createTemplate(body: {
    name: string
    type: string
    payload?: Record<string, unknown>
    description?: string
  }): Promise<CommandTemplateInfo> {
    return apiFetch<CommandTemplateInfo>('/command-templates', { method: 'POST', body })
  },
  async updateTemplate(
    id: string,
    body: Partial<{ name: string; type: string; payload: Record<string, unknown>; description: string }>,
  ): Promise<CommandTemplateInfo> {
    return apiFetch<CommandTemplateInfo>(`/command-templates/${id}`, { method: 'PATCH', body })
  },
  async deleteTemplate(id: string): Promise<void> {
    await apiFetch(`/command-templates/${id}`, { method: 'DELETE' })
  },

  // ---------- Fase 2: broadcast ----------
  async broadcast(body: {
    type?: string
    template_id?: string
    agent_ids: string[]
    confirm?: boolean
    idempotency_key: string
  }): Promise<BroadcastResult> {
    const res = await apiFetch<Record<string, unknown>>('/commands/broadcast', { method: 'POST', body })
    return {
      batch_id: String(res.batch_id ?? res.id ?? ''),
      created: Array.isArray(res.created) ? (res.created as BroadcastCreatedItem[]) : [],
      skipped: Array.isArray(res.skipped) ? (res.skipped as BroadcastSkippedItem[]) : [],
    }
  },
  async createQuestionBroadcast(body: {
    question: string
    agent_ids: string[]
    kind?: BroadcastKind
  }): Promise<{ broadcast_id: string; question_count: number; kind: BroadcastKind }> {
    return apiFetch('/broadcasts', { method: 'POST', body })
  },
  async listQuestionBroadcasts(params: { page?: number; page_size?: number } = {}): Promise<Page<QuestionBroadcastListItem>> {
    const res = await apiFetch('/broadcasts', { query: { ...params } })
    return normalizePage<QuestionBroadcastListItem>(res, params.page ?? 1, params.page_size ?? 20)
  },
  async getQuestionBroadcast(id: string): Promise<QuestionBroadcastDetail> {
    return apiFetch<QuestionBroadcastDetail>(`/broadcasts/${id}`)
  },
  async deleteQuestionBroadcast(id: string): Promise<{ broadcast_id: string; deleted: number }> {
    return apiFetch(`/broadcasts/${id}`, { method: 'DELETE' })
  },
  async listBatches(params: { page?: number; page_size?: number } = {}): Promise<Page<BatchInfo>> {
    const res = await apiFetch('/commands/batches', { query: params })
    return normalizePage<BatchInfo>(res, params.page ?? 1, params.page_size ?? 20)
  },
  async getBatch(id: string): Promise<{ batch: BatchInfo; commands: CommandInfo[] }> {
    const res = await apiFetch<Record<string, unknown>>(`/commands/batches/${id}`)
    const nested = (res.batch ?? null) as BatchInfo | null
    const batch = (nested ?? res) as BatchInfo
    let commands: CommandInfo[] = []
    if (Array.isArray(res.commands)) commands = res.commands as CommandInfo[]
    else if (nested && Array.isArray(nested.commands)) commands = nested.commands
    return { batch, commands }
  },

  // ---------- Fase 2: alert multi-kanal ----------
  async listAlerts(params: { page?: number; page_size?: number } = {}): Promise<Page<AlertNotificationInfo>> {
    const res = await apiFetch('/alerts', { query: params })
    return normalizePage<AlertNotificationInfo>(res, params.page ?? 1, params.page_size ?? 20)
  },
  async testAlert(channel: 'webhook' | 'telegram'): Promise<Record<string, unknown>> {
    const res = await apiFetch<unknown>('/settings/alerts/test', { method: 'POST', body: { channel } })
    if (res && typeof res === 'object') return res as Record<string, unknown>
    return { ok: true }
  },

  // ---------- Fase 3: pengguna & peran (ADMIN) ----------
  async listUsers(): Promise<UserInfo[]> {
    const res = await apiFetch<unknown>('/users')
    return normalizePage<UserInfo>(res, 1, 500).items.map((u) => {
      const r = u as Record<string, unknown>
      return {
        ...u,
        role: String(r.role ?? 'VIEWER').toUpperCase(),
        disabled:
          r.disabled === true ||
          r.disabled === 'true' ||
          (typeof r.disabled_at === 'string' && !!r.disabled_at) ||
          r.disabled_at instanceof Date,
      }
    })
  },
  async createUser(body: { email: string; password: string; role: string }): Promise<UserInfo> {
    return apiFetch<UserInfo>('/users', { method: 'POST', body })
  },
  async updateUser(id: string, body: { role?: string; disabled?: boolean }): Promise<UserInfo> {
    return apiFetch<UserInfo>(`/users/${id}`, { method: 'PATCH', body })
  },
  async resetUserPassword(id: string, password: string): Promise<unknown> {
    return apiFetch(`/users/${id}/reset-password`, { method: 'POST', body: { password } })
  },

  // ---------- Fase 3: aturan otomasi ----------
  async listRules(): Promise<AutomationRuleInfo[]> {
    const res = await apiFetch<unknown>('/automation/rules')
    return normalizePage<Record<string, unknown>>(res, 1, 500).items.map(normalizeRule)
  },
  async createRule(body: Record<string, unknown>): Promise<AutomationRuleInfo> {
    const res = await apiFetch<Record<string, unknown>>('/automation/rules', { method: 'POST', body })
    return normalizeRule(res)
  },
  async updateRule(id: string, body: Record<string, unknown>): Promise<AutomationRuleInfo> {
    const res = await apiFetch<Record<string, unknown>>(`/automation/rules/${id}`, { method: 'PATCH', body })
    return normalizeRule(res)
  },
  async deleteRule(id: string): Promise<void> {
    await apiFetch(`/automation/rules/${id}`, { method: 'DELETE' })
  },
  async toggleRule(id: string): Promise<AutomationRuleInfo> {
    const res = await apiFetch<Record<string, unknown>>(`/automation/rules/${id}/toggle`, { method: 'POST' })
    return normalizeRule(res)
  },

  // ---------- Fase 3: jadwal perintah ----------
  async listSchedules(): Promise<ScheduleInfo[]> {
    const res = await apiFetch<unknown>('/schedules')
    return normalizePage<Record<string, unknown>>(res, 1, 500).items.map(normalizeSchedule)
  },
  async createSchedule(body: Record<string, unknown>): Promise<ScheduleInfo> {
    const res = await apiFetch<Record<string, unknown>>('/schedules', { method: 'POST', body })
    return normalizeSchedule(res)
  },
  async updateSchedule(id: string, body: Record<string, unknown>): Promise<ScheduleInfo> {
    const res = await apiFetch<Record<string, unknown>>(`/schedules/${id}`, { method: 'PATCH', body })
    return normalizeSchedule(res)
  },
  async deleteSchedule(id: string): Promise<void> {
    await apiFetch(`/schedules/${id}`, { method: 'DELETE' })
  },
  async toggleSchedule(id: string): Promise<ScheduleInfo> {
    const res = await apiFetch<Record<string, unknown>>(`/schedules/${id}/toggle`, { method: 'POST' })
    return normalizeSchedule(res)
  },

  // ---------- Fase 3: retensi & ekspor (ADMIN) ----------
  async runRetention(): Promise<RetentionRunResult> {
    const res = await apiFetch<Record<string, unknown>>('/settings/retention/run', { method: 'POST' })
    const src = (res.deleted ?? res.counts ?? res) as Record<string, unknown>
    const num = (...keys: string[]): number => {
      for (const k of keys) {
        const v = src[k]
        if (typeof v === 'number') return v
      }
      return 0
    }
    return {
      heartbeats: num('heartbeats'),
      commands: num('commands', 'terminal_commands'),
      alerts: num('alerts', 'alert_notifications'),
      pool_snapshots: num('pool_snapshots'),
    }
  },
  /** Fase 3 (§8): putar kunci enrollment — kunci lama langsung tidak berlaku. */
  async rotateEnrollmentKey(): Promise<string> {
    const res = await apiFetch<Record<string, unknown>>('/settings/enrollment-key/rotate', { method: 'POST' })
    const key = res.enrollment_key ?? res.key ?? res.new_key
    return typeof key === 'string' ? key : ''
  },
  /** Unduh CSV ekspor dengan header Authorization (fetch → blob → unduh). */
  async downloadExport(kind: 'agents' | 'commands' | 'events' | 'audit', range: string): Promise<void> {
    const base = apiBase()
    const token = getToken()
    const res = await fetch(`${base}/export/${kind}.csv?range=${encodeURIComponent(range)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (res.status === 401) {
      clearToken()
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
      throw new ApiError(401, 'Sesi berakhir. Silakan masuk kembali.')
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let msg = `Ekspor gagal (${res.status}).`
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        if (typeof parsed.message === 'string') msg = parsed.message
        else if (typeof parsed.error === 'string') msg = parsed.error
      } catch {
        /* biarkan pesan bawaan */
      }
      throw new ApiError(res.status, msg)
    }
    const blob = await res.blob()
    let filename = `${kind}.csv`
    const cd = res.headers.get('Content-Disposition') ?? ''
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
    if (m) filename = decodeURIComponent(m[1].trim())
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  },
}
