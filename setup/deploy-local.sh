#!/usr/bin/env bash
#
# setup/deploy-local.sh — publishes the checkout you are standing in to the
# Shipway install this host actually serves (/opt/shipway), and then proves it
# worked. Run as root from the checkout:
#
#   sudo ./setup/deploy-local.sh
#   sudo ./setup/deploy-local.sh --check     # report drift, change nothing
#
# Why this exists. `update.sh` is for an install cloned from a git remote: it
# runs `git pull` inside /opt/shipway. An install created from a local checkout
# (install.sh's `sync_shipway_source` rsync branch — which is how this host was
# built) has no `.git` there at all, so update.sh cannot work and never could.
# That left "get my change onto the site" as an unwritten sequence of rsync,
# npm, systemctl and a hope, which is exactly the kind of thing that gets done
# differently each time and half-done some of the time.
#
# What it guarantees, which is the point:
#
#   * The built bundle the site serves is the one built from THIS source. The
#     check at the end compares the asset hash in the live HTML against the
#     hash in the tree that was just built, over HTTP, through nginx. A deploy
#     that silently didn't take is reported as a failure, not as success.
#   * The database is backed up (with its WAL, which is where the data actually
#     lives in WAL mode) before the service restarts and any pending migration
#     applies.
#   * The service is restarted only when the server or its migrations changed.
#     A web-only change needs no restart: @fastify/static reads from disk per
#     request, so the new files are live the moment they land.
#   * The root-owned helper scripts under /opt/pgadmin are kept in step with the
#     checkout. Those live OUTSIDE the install directory, so the rsync cannot
#     reach them, and until this existed only install.sh ever copied them — a
#     deploy could ship server code that depends on a newer helper and leave the
#     old one in place, with nothing reporting the mismatch. Privileged files
#     this script will NOT install by itself are reported instead (see
#     PRIVILEGED_MANUAL below); publishing those is install.sh's job.

set -euo pipefail

readonly SHIPWAY_DIR=/opt/shipway
readonly DATA_DIR=/var/lib/shipway
readonly NODE_BIN=/opt/node/22/bin
readonly SERVICE=shipway
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CHECK_ONLY=false
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=true

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
err() { printf '\033[31mdeploy-local: %s\033[0m\n' "$*" >&2; }
die() { err "$*"; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "must be run as root (e.g. sudo ./setup/deploy-local.sh)"
[[ -f "${REPO_ROOT}/package.json" && -d "${REPO_ROOT}/server" ]] || die "not a Shipway checkout: ${REPO_ROOT}"
[[ -d "$SHIPWAY_DIR" ]] || die "${SHIPWAY_DIR} does not exist — this host was never installed"

# The base domain the dashboard is served on, read from Shipway's own settings so
# the verification step below talks to the real site rather than to a guess.
read_base_domain() {
  sudo -u deployer "${NODE_BIN}/node" -e "
    const Database = require('${SHIPWAY_DIR}/node_modules/better-sqlite3');
    try {
      const db = new Database('${DATA_DIR}/shipway.db', { readonly: true });
      const row = db.prepare('select value from settings where key = ?').get('base_domain');
      process.stdout.write(row ? JSON.parse(row.value) : '');
    } catch { process.stdout.write(''); }
  " 2>/dev/null || true
}

# The hashed entry bundle named by a dist/index.html — the one thing that is
# different for every build, and therefore the only honest way to tell whether
# what is being served is what was just built.
bundle_of() {
  grep -o 'index-[A-Za-z0-9_-]*\.js' "$1" 2>/dev/null | head -n1
}

# Root-owned scripts that live outside SHIPWAY_DIR and are safe for a deploy to publish on its own:
# plain file copies, installed by install.sh with a bare `install` and no accompanying side effect
# (no daemon-reload, no sudoers regeneration, no template rendering). Format is
# "<source under setup/>|<destination>|<mode>"; keep it in step with install.sh's own `install` lines.
#
# Both are run BY the already-whitelisted root helper (`shipway-sysops pgadmin-sync`) rather than
# being privileged entry points themselves, which is what makes syncing them here proportionate.
readonly PGADMIN_HELPERS=(
  "pgadmin-sync-servers.py|/opt/pgadmin/sync-servers.py|0755"
  "pgadmin-set-password.py|/opt/pgadmin/set-password.py|0755"
)

# Root-owned files this script deliberately does NOT install, because publishing them safely means
# doing more than copying: /usr/local/bin/shipway-sysops is the privileged helper the sudoers
# whitelist is generated against (the two have to move together), shipway.service needs a
# daemon-reload, and the nginx templates are rendered per project rather than copied. Drift in any of
# them is REPORTED so it is visible, never silently applied — run install.sh to publish them.
readonly PRIVILEGED_MANUAL=(
  "shipway-sysops|/usr/local/bin/shipway-sysops"
  "db-signon.php|/opt/shipway-db-signon/signon.php"
  "shipway.service|/etc/systemd/system/shipway.service"
)

# Lists "setup/<src> -> <dest>" for every entry whose destination is missing or differs from the
# checkout. A destination whose PARENT DIRECTORY does not exist is skipped rather than reported: it
# means the component simply is not installed on this host (a box with no pgAdmin), which is not
# drift. Takes the array by name so both tables above can share it.
helper_drift() {
  local -n table=$1
  local entry src dest
  for entry in "${table[@]}"; do
    IFS='|' read -r src dest _ <<< "$entry"
    [[ -d "$(dirname "$dest")" ]] || continue
    if [[ ! -e "$dest" ]] || ! cmp -s "${REPO_ROOT}/setup/${src}" "$dest"; then
      echo "  setup/${src} -> ${dest}"
    fi
  done
}

# --------------------------------------------------------------------------
# 1. What is about to change
# --------------------------------------------------------------------------

log "comparing ${REPO_ROOT} with ${SHIPWAY_DIR}"

# `-n` (dry run) with the same filters the real sync uses, so this lists exactly
# what the sync would touch and nothing else.
readonly RSYNC_FILTERS=(
  # `-a` minus `-og`: the checkout is root-owned and the install must be
  # deployer-owned (the chown below does that), so carrying ownership across
  # would make every single file show as changed on every run — drowning the
  # real diff and falsely marking web-only deploys as needing a restart.
  -rlptD
  # Ownership is applied by rsync as it writes, rather than by a `chown -R` afterwards. That walk
  # covered node_modules — hundreds of packages that rsync never touches — and raced with anything
  # npm was doing in there, failing on files that moved under it and (with `set -e`) taking the
  # whole deploy down with it.
  --chown=deployer:deployer
  --exclude '.git'
  --exclude 'node_modules'
  --exclude '*/node_modules'
  --exclude 'server/dist'
  --exclude 'server/data'
  --exclude 'web/dist'
  --exclude '/data'
  --exclude '*.log'
)

# `.d..t` lines are directories whose mtime alone differs — not content.
drift="$(rsync -i -n --delete "${RSYNC_FILTERS[@]}" "${REPO_ROOT}/" "${SHIPWAY_DIR}/" | grep -v '^\.d\.\.t' || true)"

if [[ -z "$drift" ]]; then
  echo "source is already in sync"
else
  echo "$drift"
fi

# Outside the rsync's reach, so reported separately or it would never be reported at all.
pgadmin_drift="$(helper_drift PGADMIN_HELPERS)"
manual_drift="$(helper_drift PRIVILEGED_MANUAL)"

if [[ -n "$pgadmin_drift" ]]; then
  echo "pgAdmin helpers to install:"
  echo "$pgadmin_drift"
fi
if [[ -n "$manual_drift" ]]; then
  err "these root-owned files differ from the checkout and this script will NOT install them:"
  echo "$manual_drift" >&2
  err "run setup/install.sh to publish them (see PRIVILEGED_MANUAL in this script for why)."
fi

# A fingerprint of the compiled server, so a restart can be decided by whether the code on disk
# actually changed rather than by what rsync happened to move. Those are not the same question: a
# tree synced by some other means (a previous half-finished deploy, someone's manual rsync) shows no
# drift at all while the running process is still executing the old build — which is exactly the
# state that produces "I deployed and nothing changed".
server_fingerprint() {
  [[ -d "${SHIPWAY_DIR}/server/dist" ]] || { echo "absent"; return; }
  find "${SHIPWAY_DIR}/server/dist" -type f -name '*.js' -exec md5sum {} + 2>/dev/null | sort -k2 | md5sum | cut -d' ' -f1
}

# The fingerprint of the build the running process actually loaded, recorded at the moment it was
# started. Comparing against it — rather than against file timestamps — is what keeps a rebuild that
# produces byte-identical output from triggering a pointless restart, while still catching a tree
# that was synced and never restarted. Missing (first run, or a service started by other means) is
# treated as "unknown", which restarts.
readonly RUNNING_FINGERPRINT_FILE="${DATA_DIR}/.running-server-fingerprint"

running_is_stale() {
  [[ -r "$RUNNING_FINGERPRINT_FILE" ]] || return 0
  [[ "$(cat "$RUNNING_FINGERPRINT_FILE")" != "$(server_fingerprint)" ]]
}

if [[ "$CHECK_ONLY" == true ]]; then
  log "check only — nothing changed"
  live_domain="$(read_base_domain)"
  if [[ -n "$live_domain" ]]; then
    live_bundle="$(curl -fsS "https://ship.${live_domain}/" 2>/dev/null | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -n1 || true)"
    echo "live bundle:     ${live_bundle:-<unreachable>}"
    echo "installed bundle: $(bundle_of "${SHIPWAY_DIR}/web/dist/index.html")"
    echo "checkout bundle:  $(bundle_of "${REPO_ROOT}/web/dist/index.html") (stale unless just built)"
  fi
  if running_is_stale; then
    echo "restart needed:   yes — ${SERVICE} started before the server build on disk"
  else
    echo "restart needed:   no (unless this deploy rebuilds the server)"
  fi
  if [[ -n "$pgadmin_drift" ]]; then
    echo "pgadmin helpers:  stale — a real run would install them and restart to resync"
  else
    echo "pgadmin helpers:  in sync"
  fi
  exit 0
fi

# --------------------------------------------------------------------------
# 2. Sync + build
# --------------------------------------------------------------------------

log "syncing source"
rsync --delete "${RSYNC_FILTERS[@]}" "${REPO_ROOT}/" "${SHIPWAY_DIR}/"

# Published from the CHECKOUT, not from ${SHIPWAY_DIR}: these are root-owned files outside the
# install directory, and installing them from the same place the rest of the deploy came from keeps
# "what is live" answerable from one tree. Same mode/ownership install.sh uses, so a host that has
# been through either path ends up identical.
pgadmin_helpers_installed=false
if [[ -n "$pgadmin_drift" ]]; then
  log "installing pgAdmin helpers"
  for entry in "${PGADMIN_HELPERS[@]}"; do
    IFS='|' read -r src dest mode <<< "$entry"
    [[ -d "$(dirname "$dest")" ]] || continue
    install -m "$mode" -o root -g root "${REPO_ROOT}/setup/${src}" "$dest"
    echo "installed: ${dest}"
    pgadmin_helpers_installed=true
  done
fi

# Cheap, idempotent, and root-only: re-grants www-data AND deployer write access on every PHP
# project's shared runtime directories. A deploy (running as deployer) cannot set an ACL on a file
# php-fpm owns, so a host provisioned before the deployer half of that grant existed keeps a
# storage/logs/laravel.log its own queue workers cannot append to. See setup/repair-app-acls.sh.
log "repairing app runtime ACLs"
"${REPO_ROOT}/setup/repair-app-acls.sh"

log "installing dependencies (as deployer)"
sudo -u deployer bash -lc "export PATH=${NODE_BIN}:\$PATH && cd ${SHIPWAY_DIR} && npm ci"

# `npm ci` has been observed to finish successfully while leaving `node_modules/.bin/tsc` uncreated,
# even though the package itself is installed — not every time, which is what makes it nasty: the
# failure lands in the middle of a deploy as a bare `tsc: not found`, long after the step that
# actually went wrong. `npm install` recreates the missing links, so the toolchain is checked here
# and repaired before anything depends on it rather than diagnosed again from scratch next time.
if [[ ! -x "${SHIPWAY_DIR}/node_modules/.bin/tsc" ]]; then
  err "npm ci left node_modules/.bin/tsc unlinked; repairing with npm install"
  sudo -u deployer bash -lc "export PATH=${NODE_BIN}:\$PATH && cd ${SHIPWAY_DIR} && npm install --no-audit --no-fund"
  [[ -x "${SHIPWAY_DIR}/node_modules/.bin/tsc" ]] || die "typescript is still not linked — cannot build"
fi

log "building (as deployer)"
# The build writes dist/ in place, so a failure here leaves the previous build serving rather than
# an empty directory: the site stays up on the old bundle, and the deploy reports failure.
sudo -u deployer bash -lc "export PATH=${NODE_BIN}:\$PATH && cd ${SHIPWAY_DIR} && npm run build"

built_bundle="$(bundle_of "${SHIPWAY_DIR}/web/dist/index.html")"
[[ -n "$built_bundle" ]] || die "build produced no ${SHIPWAY_DIR}/web/dist/index.html"

# Decided after the build, from the build's own output: either it produced different server code
# than what is on disk now, or the process running is older than that code.
needs_restart=false
if running_is_stale; then
  needs_restart=true
fi

# A new pgAdmin helper only takes effect on the next sync, and `server/src/index.ts` runs one at
# boot — so the restart IS the resync. Without this the helper lands on disk and lies dormant until
# somebody happens to create or delete a database or a user, which is the failure mode of "installed
# it, nothing changed".
if [[ "$pgadmin_helpers_installed" == true ]]; then
  needs_restart=true
fi

# --------------------------------------------------------------------------
# 3. Restart, if the server changed
# --------------------------------------------------------------------------

if [[ "$needs_restart" == true ]]; then
  log "backing up the database"
  # All three files together, with the service stopped: in WAL mode the .db can
  # be nearly empty while the real contents sit in -wal, so copying it alone
  # produces a backup that looks fine and restores nothing.
  backup_dir="${DATA_DIR}/backup-predeploy-$(date -u +%Y%m%dT%H%M%SZ)"
  systemctl stop "$SERVICE"
  mkdir -p "$backup_dir"
  for f in shipway.db shipway.db-wal shipway.db-shm; do
    [[ -e "${DATA_DIR}/${f}" ]] && cp -a "${DATA_DIR}/${f}" "${backup_dir}/"
  done
  chown -R deployer:deployer "$backup_dir"
  echo "backup: ${backup_dir}"

  # Each of these is the size of the database, and a restart makes one every time, so without a cap
  # they quietly fill the disk on a host that deploys often. Newest 5 kept — enough to step back
  # through a bad afternoon, bounded enough to forget about.
  find "$DATA_DIR" -maxdepth 1 -type d -name 'backup-predeploy-*' -printf '%f\n' 2>/dev/null |
    sort -r | tail -n +6 | while read -r old_backup; do
      rm -rf "${DATA_DIR:?}/${old_backup}"
      echo "pruned old backup: ${old_backup}"
    done

  log "restarting ${SERVICE} (pending migrations apply on boot)"
  systemctl start "$SERVICE"
  # Recorded only after a start actually happened, so a failed restart leaves the file describing
  # the last build that really ran rather than one that never loaded.
  server_fingerprint > "$RUNNING_FINGERPRINT_FILE"
else
  log "web-only change — no restart needed"
fi

# After the restart, so this reflects the sync that actually ran against the new helper.
if [[ "$pgadmin_helpers_installed" == true ]]; then
  echo "pgAdmin helpers installed; the boot sync re-registered every account's server list."
fi

# --------------------------------------------------------------------------
# 4. Prove it
# --------------------------------------------------------------------------

log "verifying"

systemctl is-active --quiet "$SERVICE" || {
  systemctl status "$SERVICE" --no-pager | head -20
  die "${SERVICE} is not running after the deploy"
}

base_domain="$(read_base_domain)"
if [[ -z "$base_domain" ]]; then
  err "no base_domain in settings — skipping the live check"
  echo "installed bundle: ${built_bundle}"
  exit 0
fi

url="https://ship.${base_domain}/"

# The service can take a moment to accept connections after a restart; the live
# check is the whole point of this script, so it waits rather than racing it.
live_bundle=""
for _ in $(seq 1 15); do
  live_bundle="$(curl -fsS "$url" 2>/dev/null | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -n1 || true)"
  [[ -n "$live_bundle" ]] && break
  sleep 1
done

[[ -n "$live_bundle" ]] || die "${url} did not serve a page — the deploy is not live"

if [[ "$live_bundle" != "$built_bundle" ]]; then
  err "the site is serving ${live_bundle} but this build produced ${built_bundle}"
  die "something is serving a different tree than ${SHIPWAY_DIR}/web/dist"
fi

cache_control="$(curl -fsSI "$url" | tr -d '\r' | awk -F': ' 'tolower($1) == "cache-control" { print $2 }')"
if [[ "$cache_control" != *"no-cache"* ]]; then
  err "warning: ${url} returned 'cache-control: ${cache_control:-<none>}' for index.html."
  err "browsers may keep serving the previous app. Expected 'no-cache' (see server/src/app.ts)."
fi

log "deployed"
echo "  ${url} is serving ${live_bundle}"
echo "  restart: ${needs_restart}"
echo
echo "If a browser still shows the old page, it is holding index.html: reload once."
