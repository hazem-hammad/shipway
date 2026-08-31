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

# An install created from a local checkout (install.sh's rsync branch) has no
# .git here, so there is nothing to pull and this script cannot be what updates
# it. Saying so — and naming the script that CAN — beats `git pull` failing with
# "not a git repository" and leaving the operator to guess what that means about
# their install.
if [[ ! -d /opt/shipway/.git ]]; then
  echo "update.sh: /opt/shipway is not a git clone, so there is nothing to pull." >&2
  echo "update.sh: this host was installed from a local checkout. Update it from that" >&2
  echo "update.sh: checkout instead:" >&2
  echo >&2
  echo "    sudo /path/to/your/checkout/setup/deploy-local.sh" >&2
  echo >&2
  exit 1
fi

sudo -u deployer git pull --ff-only

sudo -u deployer bash -lc "export PATH=/opt/node/22/bin:\$PATH && cd /opt/shipway && npm ci && npm run build"

systemctl restart shipway

echo "update.sh: done."
