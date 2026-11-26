// Fastify JSON Schemas for request validation (contract: schema validation on
// every route). Kept pragmatic: required fields + types on the main bodies.

export const registerBodySchema = {
  type: 'object',
  properties: {
    pairing_code: { type: 'string', minLength: 1 },
    agent_id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    worker_name: { type: 'string', minLength: 1 },
    boot_id: { type: 'string', minLength: 1 },
    boot_time: { type: 'string' },
    bridge_version: { type: 'string' },
    capabilities: { type: 'array', items: { type: 'string' } },
  },
  required: ['boot_id'],
  anyOf: [{ required: ['pairing_code'] }, { required: ['agent_id'] }],
} as const;

export const heartbeatBodySchema = {
  type: 'object',
  properties: {
    session_id: { type: 'string', minLength: 1 },
    sent_at: { type: 'string' },
    host: {
      type: 'object',
      properties: {
        boot_id: { type: 'string' },
        mem_available_gib: { type: 'number' },
      },
      required: ['mem_available_gib'],
    },
    miner: {
      type: 'object',
      properties: {
        service_state: { type: 'string' },
        pid: { type: ['integer', 'null'] },
        session_no: { type: ['integer', 'null'] },
        hashrate_hs: { type: 'number' },
        shares_local: { type: 'integer' },
        accepted_shares: { type: ['integer', 'null'] },
        rejected_shares: { type: ['integer', 'null'] },
        last_share_at: { type: ['string', 'null'] },
        start_blocked_reason: { type: ['string', 'null'] },
        hold_active: { type: ['boolean', 'null'] },
        hold: { type: ['boolean', 'null'] },
        job_height: { type: 'integer' },
        difficulty: { type: 'number' },
      },
      required: ['service_state', 'hashrate_hs', 'shares_local', 'job_height', 'difficulty'],
    },
  },
  required: ['session_id', 'host', 'miner'],
} as const;

export const ackBodySchema = {
  type: 'object',
  properties: {
    session_id: { type: 'string' },
  },
} as const;

export const resultBodySchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['succeeded', 'failed'] },
    output: { type: 'string' },
    exit_code: { type: 'integer' },
    error_reason: { type: 'string' },
    session_id: { type: 'string' },
  },
  required: ['status'],
} as const;

export const agentEventBodySchema = {
  type: 'object',
  properties: {
    type: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
    session_id: { type: 'string' },
  },
  required: ['type'],
} as const;

export const loginBodySchema = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 1 },
  },
  required: ['email', 'password'],
} as const;

export const pairingBodySchema = {
  type: 'object',
  properties: {
    planned_name: { type: 'string', minLength: 1 },
  },
  required: ['planned_name'],
} as const;

export const createCommandBodySchema = {
  type: 'object',
  properties: {
    type: { type: 'string', minLength: 1 },
    template_id: { type: 'string', minLength: 1 },
    payload: { type: 'object', additionalProperties: true },
    idempotency_key: { type: 'string', minLength: 1 },
    confirm: { type: 'boolean' },
  },
  required: ['idempotency_key'],
  anyOf: [{ required: ['type'] }, { required: ['template_id'] }],
} as const;

// --- Phase 2 schemas ---

export const templateCreateBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    payload: { type: 'object', additionalProperties: true },
    description: { type: 'string' },
    sensitive: { type: 'boolean' },
  },
  required: ['name', 'type'],
} as const;

export const templatePatchBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    payload: { type: 'object', additionalProperties: true },
    description: { type: 'string' },
    sensitive: { type: 'boolean' },
  },
  minProperties: 1,
} as const;

export const broadcastBodySchema = {
  type: 'object',
  properties: {
    type: { type: 'string', minLength: 1 },
    template_id: { type: 'string', minLength: 1 },
    payload: { type: 'object', additionalProperties: true },
    agent_ids: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    confirm: { type: 'boolean' },
    idempotency_key: { type: 'string', minLength: 1 },
  },
  required: ['agent_ids', 'idempotency_key'],
} as const;

export const alertTestBodySchema = {
  type: 'object',
  properties: {
    channel: { type: 'string', enum: ['webhook', 'telegram'] },
  },
  required: ['channel'],
} as const;

export const settingsPatchSchema = {
  type: 'object',
  // Value types and key names are validated in the settings service
  // (EDITABLE_SETTING_KEYS) so unknown keys produce a precise 400.
  additionalProperties: true,
  minProperties: 1,
} as const;

export const paginationQuerySchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    page_size: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
  },
} as const;

// --- Phase 3 schemas (CONTRACT-3) ---

export const userCreateBodySchema = {
  type: 'object',
  properties: {
    email: { type: 'string', minLength: 3 },
    password: { type: 'string', minLength: 1 },
    role: { type: 'string', minLength: 1 },
  },
  required: ['email', 'password', 'role'],
} as const;

export const userPatchBodySchema = {
  type: 'object',
  properties: {
    role: { type: 'string', minLength: 1 },
    disabled: { type: 'boolean' },
  },
} as const;

export const userResetPasswordBodySchema = {
  type: 'object',
  properties: {
    password: { type: 'string', minLength: 1 },
  },
  required: ['password'],
} as const;

const ruleConditionSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', minLength: 1 },
    status: { type: 'string' },
    for_sec: { type: 'number' },
  },
  required: ['kind', 'for_sec'],
} as const;

const actionSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    template_id: { type: 'string' },
    payload: { type: 'object' },
  },
} as const;

const targetSchema = {
  type: 'object',
  properties: {
    agent_ids: {
      // NOTE: the string branch must be enum-restricted to "all" — with a
      // plain {type:'string'} branch, Fastify's ajv coerceTypes:'array'
      // collapses a one-element id array into a scalar string.
      anyOf: [
        { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        { type: 'string', enum: ['all'] },
      ],
    },
  },
  required: ['agent_ids'],
} as const;

export const ruleCreateBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
    condition: ruleConditionSchema,
    action: actionSchema,
    target: targetSchema,
    cooldown_sec: { type: 'integer' },
    max_per_day: { type: 'integer' },
  },
  required: ['name', 'condition', 'action', 'target'],
} as const;

export const rulePatchBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
    condition: ruleConditionSchema,
    action: actionSchema,
    target: targetSchema,
    cooldown_sec: { type: 'integer' },
    max_per_day: { type: 'integer' },
  },
} as const;

export const toggleBodySchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
  },
  required: ['enabled'],
} as const;

export const scheduleCreateBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
    cron: { type: 'string', minLength: 1 },
    action: actionSchema,
    target: targetSchema,
    broadcast: { type: 'boolean' },
  },
  required: ['name', 'cron', 'action', 'target'],
} as const;

export const schedulePatchBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
    cron: { type: 'string', minLength: 1 },
    action: actionSchema,
    target: targetSchema,
    broadcast: { type: 'boolean' },
  },
} as const;

export const selfRegisterBodySchema = {
  type: 'object',
  properties: {
    enrollment_key: { type: 'string', minLength: 1 },
    agent_name: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    worker_name: { type: 'string', minLength: 1 },
    boot_id: { type: 'string', minLength: 1 },
    boot_time: { type: 'string' },
    bridge_version: { type: 'string' },
    capabilities: { type: 'array', items: { type: 'string' } },
  },
  required: ['enrollment_key', 'agent_name', 'boot_id'],
} as const;
