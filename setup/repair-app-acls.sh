#!/usr/bin/env bash
#
# setup/repair-app-acls.sh — re-grants, as root, the runtime write access that
# `grantRuntimeWriteAccess` (server/src/deploy/pipeline.ts) grants on every PHP
# deploy: an ACL entry for BOTH php-fpm's `www-data` and Shipway's `deployer` on
# each shared runtime directory, plus a matching `default:` entry so everything
# created inside one later inherits it.
#
#   sudo ./setup/repair-app-acls.sh
#
# Why this needs root, and why the deploy cannot do it alone. Changing a file's
# ACL requires OWNING the file — write access is not enough. A deploy runs as
# `deployer`, so it can set these entries on the directories it owns and on the
# files it wrote, but not on a file php-fpm created at runtime: that one is
# `www-data:www-data`, and `setfacl` answers "Operation not permitted". On a host
# provisioned before the `deployer` half of that grant existed, the file this
# bites hardest is `storage/logs/laravel.log` — first written by a web request,
# and thereafter unwritable by the project's own queue workers, which run as
# `deployer` and die on their first log line.
#
# Files created AFTER the default entries are in place inherit them, so this is a
# one-time repair per host rather than something the deploy keeps needing. It is
# idempotent and safe to re-run: `setfacl` skips a file whose ACL already says
# what it is being asked to say, so a healthy tree is a no-op.
#
# Scope. Only directories that ALREADY carry a `www-data` ACL entry are touched —
# i.e. exactly the trees a PHP deploy has granted before. A node/static project's
# shared directory has no such entry and is left alone, so this never widens
# access to a project php-fpm was never given.

set -euo pipefail

readonly APPS_DIR=/var/deploy/apps
readonly WEB_USER=www-data
readonly DEPLOY_USER=deployer

if [[ "$(id -u)" -ne 0 ]]; then
  echo "repair-app-acls.sh: must be run as root (e.g. sudo ./setup/repair-app-acls.sh)" >&2
  exit 1
fi

if ! command -v setfacl >/dev/null 2>&1; then
  echo "repair-app-acls.sh: setfacl not found (apt-get install acl) — nothing done" >&2
  exit 1
fi

# True when $1 already has an access ACL entry for www-data, which is what marks
# a tree as one a PHP deploy manages.
php_managed() {
  getfacl -p -- "$1" 2>/dev/null | grep -q "^user:${WEB_USER}:"
}

repaired=0
for target in "${APPS_DIR}"/*/shared/*/ "${APPS_DIR}"/*/current/bootstrap/cache/; do
  [[ -d "$target" ]] || continue
  php_managed "$target" || continue
  setfacl -R \
    -m "u:${WEB_USER}:rwX" -m "d:u:${WEB_USER}:rwX" \
    -m "u:${DEPLOY_USER}:rwX" -m "d:u:${DEPLOY_USER}:rwX" \
    -- "${target%/}"
  echo "repair-app-acls: ${WEB_USER} and ${DEPLOY_USER} can write ${target%/}"
  repaired=$((repaired + 1))
done

echo "repair-app-acls: ${repaired} runtime director$([[ $repaired -eq 1 ]] && echo y || echo ies) checked."
