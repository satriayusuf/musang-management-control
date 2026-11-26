# Muse Management Control

Centralized monitoring, control, and recovery platform for ~100 Muse agents across
many VMs: agent registry with persistent identity, heartbeat/session tracking with
VM-replacement detection, worker (miner) health from bridge snapshots cross-checked
with pool data when configured, a PostgreSQL-backed command queue with verified
results, audit trail, and a real-time dashboard.

Spec: `spec/spek-flow-muse-management-control-v1.1.pdf` · Implementation contract:
`CONTRACT.md` · Deployment: `deploy/README.md`.

## Layout

| Folder | What |
|---|---|
| `backend/` | Fastify 5 + TypeScript API + WebSocket, Prisma/PostgreSQL. One process. |
| `frontend/` | Nuxt 4 + Vue 3, static build (`nuxt generate`), Bahasa Indonesia UI. |
| `bridge/` | Agent bridge: Node 20+ TypeScript bundled to a single `dist/bridge.cjs`; systemd installer in `bridge/install.sh`. Demo mode by default. |
| `deploy/` | Nginx config, systemd unit, PostgreSQL tuning, Docker Compose (3 services), deployment README. |

## Development

```bash
# PostgreSQL (local): databases muse_control + muse_control_test
cd backend && cp .env.example .env   # adjust DATABASE_URL / ADMIN_PASSWORD
npm install && npx prisma migrate dev && npm run dev        # API on :3001, docs at /docs

cd ../frontend && npm install
NUXT_PUBLIC_API_BASE=http://127.0.0.1:3001/api npm run dev  # dashboard dev server
npm run generate                                            # static production build

cd ../bridge && npm install && npm run build
MUSE_SERVER_URL=http://127.0.0.1:3001 MUSE_PAIRING_CODE=<code from dashboard> \
  MUSE_BRIDGE_DIR=~/workspace/muse-bridge-demo node dist/bridge.cjs
```

Tests: `cd backend && npm test` (unit + integration), `cd bridge && npm test`.

## Phase status

Phase 1 (MVP) is implemented and deployed. Phase 2 (broadcast commands, templates,
advanced analytics, multi-channel alerts) and Phase 3 (automation, multi-user,
retention/export) are intentionally NOT built — they start only after Phase 1
approval.
