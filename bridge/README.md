# Muse Bridge

The agent-side bridge for **Muse Management Control**. One lightweight
Node.js process per agent VM. It registers (or re-attaches) the agent with the
central server, heartbeats every ~30 s with a miner snapshot, polls the
command queue, executes allowlisted commands, and reports results.

Design rules (from `../CONTRACT.md`):

- **Outbound only** — the bridge only ever opens HTTPS connections to the
  server. No inbound ports on the VM.
- **One agent, one persistent identity** — identity lives in
  `~/workspace/muse-bridge/` (the only directory that survives VM
  replacement). A VM replacement is detected server-side via the boot ID and
  never creates a duplicate agent.
- **Never dies on network failure** — exponential backoff (1 s → 60 s) and it
  keeps retrying. It also keeps running when the miner cannot start.
- **Allowlist only** — the bridge executes nothing outside
  `miner.status / miner.run / miner.restart / miner.reinstall / miner.hold /
  miner.unhold`, intersected with the agent's registered capabilities.
- **LOW_MEMORY honesty** — `miner.run` (and restart/reinstall) refuses to
  start the miner when available memory is below the server-provided
  `min_mem_start_gib`, and reports the actual figure instead of failing
  silently.
- **The raw token is never logged** and is stored in its own file with mode
  `0600`.

## Requirements

- Node.js 20+
- Linux with systemd (for the installed service; the bundle also runs
  standalone for testing)

## Build

```bash
npm install --workspaces=false   # dev-only deps: typescript, esbuild, vitest
npm run build                    # -> dist/bridge.cjs (single-file bundle)
npm run typecheck
npm test
```

The bridge has **zero runtime dependencies** — the bundle uses only Node
builtins and the global `fetch`.

## Install (on an agent VM)

```bash
npm run build
./install.sh
```

`install.sh` is idempotent and safe to run on every boot: it copies
`dist/bridge.cjs` into the bridge dir, writes
`/etc/systemd/system/muse-bridge.service` **only if the rendered unit
differs**, runs `daemon-reload`, enables the service, and restarts it when
the unit changed (otherwise it just makes sure it is running). It uses
`sudo` when not run as root.

Then configure the bridge (see below) in the bridge dir:

- `~/workspace/muse-bridge/bridge.env` (read by the systemd unit), or
- `~/workspace/muse-bridge/config.json`, or
- environment variables directly.

```bash
# bridge.env example
MUSE_SERVER_URL=https://control.example.com
MUSE_PAIRING_CODE=XXXX-XXXX        # only needed for the very first registration
MUSE_AGENT_NAME=rig-utama
MUSE_WORKER_NAME=czx-utama-7d66
MUSE_BRIDGE_MODE=demo
```

After the first successful registration the pairing code is no longer used —
the bridge re-attaches with its stored token, including after VM replacement.

```bash
systemctl status muse-bridge
journalctl -u muse-bridge -f
```

## Run without systemd (development / smoke test)

```bash
MUSE_SERVER_URL=http://127.0.0.1:3001 \
MUSE_PAIRING_CODE=XXXX-XXXX \
MUSE_BRIDGE_DIR=/tmp/muse-bridge-dev \
node dist/bridge.cjs
```

## Configuration

Environment variables win over `<bridge dir>/config.json` (same names in
snake_case there: `server_url`, `pairing_code`, ...).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `MUSE_SERVER_URL` | yes | — | Base URL of the management server |
| `MUSE_PAIRING_CODE` | first run only | — | One-time pairing code from the dashboard |
| `MUSE_AGENT_NAME` | no | hostname | Display name of the agent |
| `MUSE_WORKER_NAME` | no | — | Pool worker name (secondary identity key) |
| `MUSE_BRIDGE_MODE` | no | `demo` | `demo` (simulated miner) or `real` (systemctl) |
| `MUSE_MINER_UNIT` | real mode | `""` | systemd unit of the miner, e.g. `bnt-miner.service` |
| `MUSE_MINER_STATS_URL` | no | — | Local HTTP endpoint serving miner statistics as JSON; merged into the snapshot when set (CONTRACT-6) |
| `MUSE_REINSTALL_SCRIPT` | no | — | Script run by `miner.reinstall` in real mode |
| `MUSE_BRIDGE_DIR` | no | `~/workspace/muse-bridge` | Identity/config directory |
| `MUSE_CAPABILITIES` | no | all six commands | Comma-separated capability override |
| `DEMO_MEM_GIB` | no | `6.8` | Demo mode: simulated MemAvailable (GiB) |
| `DEMO_MINER_START` | no | `active` | Demo mode: initial miner state (`active`/`inactive`) |
| `DEMO_SEED` | no | `1337` | Demo mode: seed for the hashrate random walk |

Heartbeat interval and the minimum-memory start threshold are **not** local
settings — the server provides them in register/heartbeat responses and the
bridge adopts them at runtime.

## Modes

- **demo** (default): a simulated miner state machine. Starts `active`
  (hashrate random-walks 1.4–1.91 H/s, shares and job height advance per
  heartbeat) or `inactive` with `DEMO_MINER_START=inactive`. Commands flip
  the simulated state. Set `DEMO_MEM_GIB=2.4` to exercise the GAGAL START /
  LOW_MEMORY path. Nothing real is touched.
- **real**: miner state is read from `systemctl is-active/show` for
  `MUSE_MINER_UNIT`; start/restart go through systemctl (via `sudo -n` when
  not root); reinstall runs `MUSE_REINSTALL_SCRIPT` (fails with
  `NOT_CONFIGURED` when unset). Hashrate/share figures are reported as
  `null` — the bridge cannot read them and does not invent them.

## Files in the bridge dir

| File | Purpose |
|---|---|
| `bridge.cjs` | The bundled bridge (copied by install.sh) |
| `identity.json` | `{ agent_id, name, worker_name }` |
| `token` | Raw agent token, mode `0600` |
| `hold` | Presence flag: auto-recovery held (`miner.hold` / `miner.unhold`) |
| `bridge.env` / `config.json` | Configuration (optional) |

## Shutdown behavior

On `SIGTERM`/`SIGINT` the bridge makes a best-effort `AGENT_SHUTDOWN` event
report (2 s budget) before exiting, so the server can distinguish a clean
reboot from a VM replacement. If the VM simply vanishes, no event is sent —
the server marks the agent unreachable after 3 missed heartbeats instead.
