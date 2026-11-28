# CONTRACT-10 — Phase 10: bridge.update command (self-update from Pusat Perintah)

Source: Satria's request 2026-11-28 ~20:07 WIB — a dedicated command in
Pusat Perintah that makes an agent re-check its version against the
server's latest and install the new one when they differ, covering the
bridge AND the runtime's instruction document (agent.md).

## Principle

One new command type, `bridge.update`, executed by the BRIDGE (normal
bridge claim path, agent token — not the runtime queue):

1. **Bridge bundle** — the bridge downloads `{server}/bridge.cjs`,
   compares SHA-256 with its installed `<bridgeDir>/bridge.cjs`. Equal
   → nothing to do. Different → the download is syntax-checked
   (`node --check`), the current bundle is backed up to
   `bridge.cjs.bak`, the new bundle is installed atomically (temp file
   + rename), and AFTER the command result (and the fresh heartbeat)
   has been delivered, the bridge process exits so systemd
   (`Restart=always`) revives it on the new bundle.
2. **Runtime instructions** — the same execution downloads
   `{server}/agent.md` and stores the newest copy at
   `<bridgeDir>/agent.md` when it differs from the stored one. The
   runtime side of the update is completed by the runtime itself: the
   amended agent.md (Langkah 5) tells runtimes to watch that local copy
   each round and re-apply changed instructions. The bridge cannot
   rewrite a runtime's behaviour directly; it guarantees the newest
   instructions are present on the VM and flags the change in the
   command result.

The command takes NO payload parameters: download URLs are derived
from the bridge's configured server URL only, never from the command,
so a command can never point a bridge at another host.

## Server (backend)

- `COMMAND_TYPES` gains `bridge.update`; it is SENSITIVE (dashboard
  confirmation required, like miner.run/restart). It is NOT in
  `STATE_CHANGING_TYPES`: success is the bridge's own verified result
  (it reports the from/to SHA-256 of the bundle and whether the
  agent.md copy changed) — a heartbeat snapshot cannot prove a bundle
  swap, and an already-current bridge produces no restart to observe.
- A seeded default template "Perbarui Bridge" (type `bridge.update`,
  sensitive) surfaces it in Pusat Perintah next to the miner templates.
- Capability gating is unchanged: the agent's registered capabilities
  must include `bridge.update` (new bridges register it by default).

## Bridge

- `BRIDGE_VERSION` → `1.1.0`; `COMMAND_ALLOWLIST` and
  `DEFAULT_CAPABILITIES` gain `bridge.update`.
- New module `src/updater.ts` (unit-tested with an injected fetch):
  defensive download (15 s timeout, 8 MiB cap, no auth headers),
  SHA-256 compare, `node --check` before install, `.bak` backup,
  atomic rename. agent.md refresh is best-effort: its failure is noted
  in the result output and never fails an otherwise successful bundle
  update (and vice versa a bundle failure fails the command; the
  agent.md refresh is still attempted and reported).
- Restart signalling: the executor's deps gain `serverUrl` and an
  `onSelfRestart` callback. The callback only sets a flag on the
  Bridge; the cycle loop checks it after `handleCommand` completes
  (result + fresh heartbeat delivered) and exits the process. If the
  bridge is not under systemd, the new bundle simply takes effect on
  the next manual start — the result says an update was installed.

## Frontend

- `COMMAND_TYPES` in labels.ts gains
  `{ value: 'bridge.update', label: 'Perbarui Bridge', sensitive: true }`,
  which surfaces it in the Pusat Perintah form (single + broadcast)
  with the existing sensitive-command confirmation flow.

## agent.md

- Langkah 5 gains the runtime watch rule for `<bridgeDir>/agent.md`
  (re-apply when its content changes; keep a hash of the instructions
  being followed), and Langkah 2/a short note records that Pusat
  Perintah's `bridge.update` refreshes both the bundle and that local
  copy. Template edits are covered by Satria's explicit go-ahead for
  this feature (2026-11-28 20:09 WIB, "gas lanjut").

## Bootstrap limitation (stated to Satria)

Bridges installed before this phase do not know `bridge.update` and
reject it (REJECTED_SCOPE), and their runtimes do not yet watch the
local agent.md copy. The command works for every agent enrolled or
reinstalled with bridge 1.1.0 onward; the already-running fleet needs
the one-time bootstrap (broadcast instruction or reinstall) described
on 2026-11-28. Fleet turnover makes coverage grow on its own.
