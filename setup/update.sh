#!/usr/bin/env bash
#
# setup/update.sh — updates an already-installed Shipway host in place:
# pulls the latest commit, rebuilds, and restarts the service. Run as root
# (it needs to restart shipway.service and act as the `deployer` user):
#
#   sudo /opt/shipway/setup/update.sh
#
# Database migrations are NOT run here as a separate step — `openDb`
# (server/src/db/index.ts) applies any pending Drizzle migration
# automatically every time the server process starts, so `systemctl
# restart shipway` below covers it.
#
# Deviation from a literal reading of the task brief: the brief's inline
# `PATH=/opt/node/22/bin:$PATH npm ci && npm run build` only puts that PATH
# prefix on `npm ci` (a bare `VAR=val cmd` env-prefix scopes to a single
# simple command, not to what follows `&&`) — `npm run build` would then
# run with deployer's normal login PATH, which has no `npm` on it. This
# uses `export PATH=... &&` instead, exactly like the ExecStart lines
# server/src/system/templates.ts renders for app/worker units, so both
# commands see the prefixed PATH.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "update.sh: must be run as root (e.g. sudo ./setup/update.sh)" >&2
  exit 1
fi

cd /opt/shipway

sudo -u deployer git pull --ff-only

sudo -u deployer bash -lc "export PATH=/opt/node/22/bin:\$PATH && cd /opt/shipway && npm ci && npm run build"

systemctl restart shipway

echo "update.sh: done."
