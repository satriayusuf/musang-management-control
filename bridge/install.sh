#!/usr/bin/env bash
# Muse Bridge installer — idempotent.
#
# - Ensures the bridge dir exists (default ~/workspace/muse-bridge, the only
#   location that survives VM replacement).
# - Copies the bundled bridge.cjs into the bridge dir when a build is present
#   next to this script (dist/bridge.cjs) and its content differs.
# - Writes /etc/systemd/system/muse-bridge.service ONLY when its rendered
#   content differs from what is installed, then daemon-reload + restart.
#   When unchanged, the service is merely ensured enabled + started.
#
# Safe to run on every boot: it recreates the unit when missing or changed —
# the same reinstall pattern the miner watchdog uses on these VMs.
set -euo pipefail

BRIDGE_DIR="${MUSE_BRIDGE_DIR:-$HOME/workspace/muse-bridge}"
SERVICE_NAME="muse-bridge.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE_PATH="$(command -v node || true)"
if [ -z "${NODE_PATH}" ]; then
  echo "ERROR: node not found in PATH; install Node.js 20+ first." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

mkdir -p "${BRIDGE_DIR}"

# --- bundle -------------------------------------------------------------
if [ -f "${SCRIPT_DIR}/dist/bridge.cjs" ]; then
  if ! cmp -s "${SCRIPT_DIR}/dist/bridge.cjs" "${BRIDGE_DIR}/bridge.cjs" 2>/dev/null; then
    cp "${SCRIPT_DIR}/dist/bridge.cjs" "${BRIDGE_DIR}/bridge.cjs"
    echo "bridge.cjs updated in ${BRIDGE_DIR}"
  fi
fi
if [ ! -f "${BRIDGE_DIR}/bridge.cjs" ]; then
  echo "ERROR: ${BRIDGE_DIR}/bridge.cjs not found — build first (npm run build) or copy the bundle there." >&2
  exit 1
fi

# --- systemd unit (rendered; placeholders resolved here) -----------------
RUN_USER="$(id -un)"
USER_LINE=""
if [ "${RUN_USER}" != "root" ]; then
  USER_LINE="User=${RUN_USER}"
fi

RENDERED="$(mktemp)"
trap 'rm -f "${RENDERED}"' EXIT
cat > "${RENDERED}" <<EOF
[Unit]
Description=Muse Bridge Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_PATH} ${BRIDGE_DIR}/bridge.cjs run
Restart=always
RestartSec=10
WorkingDirectory=${BRIDGE_DIR}
Environment=MUSE_BRIDGE_DIR=${BRIDGE_DIR}
EnvironmentFile=-${BRIDGE_DIR}/bridge.env
${USER_LINE}

[Install]
WantedBy=multi-user.target
EOF

CHANGED=0
if [ ! -f "${SERVICE_PATH}" ] || ! ${SUDO} cmp -s "${RENDERED}" "${SERVICE_PATH}"; then
  ${SUDO} cp "${RENDERED}" "${SERVICE_PATH}"
  CHANGED=1
  echo "systemd unit written: ${SERVICE_PATH}"
fi

if [ "${CHANGED}" -eq 1 ]; then
  ${SUDO} systemctl daemon-reload
fi
${SUDO} systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true

if [ "${CHANGED}" -eq 1 ]; then
  ${SUDO} systemctl restart "${SERVICE_NAME}"
  echo "muse-bridge restarted with new unit"
else
  ${SUDO} systemctl start "${SERVICE_NAME}" || true
  echo "muse-bridge unit unchanged; service ensured running"
fi

echo "Done. Config: put MUSE_SERVER_URL / MUSE_PAIRING_CODE in ${BRIDGE_DIR}/bridge.env or ${BRIDGE_DIR}/config.json"
echo "Status: systemctl status ${SERVICE_NAME}   Logs: journalctl -u ${SERVICE_NAME} -f"
