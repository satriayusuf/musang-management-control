# Deployment — Muse Management Control (Phase 1)

Production target: one VPS, 2 CPU / 2 GB RAM. Two supported shapes.

## Shape A — no Docker (recommended at 2 GB; this is what production runs)

Components: Nginx (static frontend + reverse proxy + TLS), the Fastify backend as a
systemd service, PostgreSQL from the OS packages (tuned).

1. Install Node.js 22 (NodeSource) and PostgreSQL.
2. Create the database and user:
   `sudo -u postgres psql -c "CREATE USER muse WITH PASSWORD '<pw>';"`
   `sudo -u postgres psql -c "CREATE DATABASE muse_control OWNER muse;"`
3. Apply the tuning in `postgres-tuning.conf` (ALTER SYSTEM …), restart PostgreSQL.
4. Copy `backend/` to `/opt/muse-control/backend`, write `.env` (see `backend/.env.example`;
   production needs a strong `JWT_SECRET` and `ADMIN_PASSWORD`), then:
   `npm install && npx prisma generate && npx prisma migrate deploy && npm run build`
5. Install `systemd/muse-control.service` to `/etc/systemd/system/`,
   `systemctl daemon-reload && systemctl enable --now muse-control`.
6. Build the frontend on a dev machine (`npm run generate` in `frontend/`) and copy
   `frontend/.output/public/` to `/var/www/musang/` (readable by the nginx user).
7. TLS: request a Cloudflare Origin CA certificate for the hostname and install it at
   `/etc/nginx/ssl/<host>.pem|.key`; set the zone SSL mode for this hostname to
   Full (Strict) — e.g. via a Cloudflare Configuration Rule scoped to the hostname,
   so other hosts on the same zone/VPS are unaffected.
8. Install `nginx/musang.mikasu.lol.conf` into `/etc/nginx/sites-enabled/`,
   `nginx -t && systemctl reload nginx`.
9. Point DNS at the VPS (Cloudflare A record, proxied).

Verify: `curl https://<host>/` loads the dashboard, `POST /api/auth/login` returns a
token, `GET /healthz` on the backend (127.0.0.1:3001) reports `db: true`.

## Shape B — Docker Compose (three services only)

`docker-compose.yml` in this folder: `postgres` (tuned flags, 512 MB limit),
`app` (backend, 384 MB), `nginx` (static + proxy, 128 MB). Provide a `.env` next to
the compose file with `POSTGRES_PASSWORD`, `JWT_SECRET`, `ADMIN_PASSWORD`
(and optionally `ADMIN_EMAIL`). Then `docker compose up -d --build`.
The nginx config path inside the container expects the same layout; adjust the
`server_name` and certificate paths in `nginx/musang.mikasu.lol.conf` for your host.

## RAM budget vs measured (production, idle, 2026-11-26)

| Component | Budget | Measured idle |
|---|---|---|
| PostgreSQL (tuned) | ~250–350 MB | ~197 MB |
| Fastify backend | ~100–150 MB | ~91 MB |
| Nginx | ~15–25 MB | ~23 MB |
| **Stack total** | **~700–900 MB incl. OS** | **~311 MB (components)** |

Whole VPS at measurement time: 685 MB used of 1.9 GB (includes the OS and the
host's pre-existing services), 1.2 GB available.

## Bridge installation (per agent VM)

See `bridge/README.md`. Short version: copy `bridge/dist/bridge.cjs` to the VM,
then run `bridge/install.sh` with `MUSE_SERVER_URL` and a one-time
`MUSE_PAIRING_CODE` from the dashboard (Agents → Tambah Agent). The installer is
idempotent and manages the `muse-bridge.service` systemd unit.
