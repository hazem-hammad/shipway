#!/usr/bin/env bash
#
# setup/install.sh — provisions a fresh Ubuntu 24.04 server as a Shipway
# host: nginx, PHP 8.1-8.4, MySQL, PostgreSQL, Redis, Node 18/20/22,
# Mailpit, certbot, the `deployer` user + its narrow sudo helper, then
# builds and starts Shipway itself and points DNS/nginx at it.
#
# Idempotent: safe to re-run after a partial failure or to pick up a fix.
# Packages/binaries already installed are skipped; generated secrets are
# cached in /root/.shipway-install-secrets so re-running never rotates a
# credential a project or the running server may already depend on.
#
# Must be run as root (`sudo ./setup/install.sh`) from inside a Shipway
# checkout, or with SHIPWAY_REPO_URL set. See DEPLOYMENT.md for the full
# walkthrough. Non-interactive installs can set SHIPWAY_BASE_DOMAIN,
# SHIPWAY_SERVER_IP, SHIPWAY_CF_API_TOKEN, SHIPWAY_ACME_EMAIL instead of
# answering the prompts, plus SHIPWAY_NONINTERACTIVE=1 to skip the one
# remaining interactive gate (the DNS-not-pointed-here confirmation in
# `check_dns_resolution`) and proceed unattended.
#
# Runs a preflight check (root, OS, free disk, ports 80/443, outbound
# connectivity, Cloudflare token/zone access, DNS pointing at this server)
# before making any change to the system, and a postflight check (service
# status + a live `/api/health` retry loop) before printing the final
# summary — see `preflight`/`postflight` in `main` below.
#
# --- Deliberate deviations from a literal reading of the spec/task brief,
#     made for correctness on a real Ubuntu 24.04 box, documented here so
#     a reviewer isn't left guessing why the code doesn't match verbatim:
#
#   - Extra apt packages beyond the brief's literal list: `rsync` (to copy
#     a local checkout into /opt/shipway), `jq` (to parse the GitHub/
#     Cloudflare JSON APIs reliably instead of fragile grep/sed), and
#     `software-properties-common` (provides `add-apt-repository`, which
#     the ondrej/php PPA step needs and which is not guaranteed present on
#     a minimal Ubuntu server image).
#   - MySQL admin user is granted at BOTH 'shipway_admin'@'localhost' (as
#     literally specified) and 'shipway_admin'@'127.0.0.1'. MySQL's
#     special-cased "localhost means the Unix socket" behavior lives in
#     client libraries (the `mysql` CLI), not the server's account
#     matching — a TCP connection to 127.0.0.1 (which is what mysql2, and
#     therefore `mysql_admin_url`, always uses — see
#     server/src/services/dbprovision.ts's `connectionEnv`) is not
#     guaranteed to match a `@localhost`-only grant on every install
#     (it depends on reverse-DNS/`skip-name-resolve`). Granting both hosts
#     with the same password makes the account work regardless.
#   - setup/sudoers.d-shipway pins nginx's real path (`/usr/sbin/nginx`,
#     not `/usr/bin/nginx` — see the comments in that file for why).
#
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

readonly SCRIPT_DIR REPO_ROOT
readonly SECRETS_FILE=/root/.shipway-install-secrets
readonly DEPLOYER_HOME=/var/deploy
readonly SHIPWAY_DIR=/opt/shipway
readonly NODE_VERSIONS=(18 20 22)
readonly PHP_VERSIONS=(8.1 8.2 8.3 8.4)
readonly PHP_EXTENSIONS=(fpm cli mysql pgsql sqlite3 redis mbstring xml curl zip gd bcmath intl)
# phpMyAdmin, served at ship.<base-domain>/db/phpmyadmin. Checksum is the one phpmyadmin.net
# publishes alongside the tarball, verified before anything is extracted.
#
# NOTE the PHP ceiling: 5.2.3 declares php_versions ">=7.2,<8.4", so this must run on the 8.3 FPM
# socket. Pointing it at 8.4 (also installed on this box) is not merely unsupported — phpMyAdmin
# refuses to start on an untested major.
readonly PMA_VERSION=5.2.3
readonly PMA_SHA256=03de2640bb25c9a6f96bc94eae316080b5fd5bd58d769e1318ba9dd94c83364c
readonly PMA_PHP_VERSION=8.3
# pgAdmin 4, served at ship.<base-domain>/db/pgadmin. Installed from PyPI into its own venv rather
# than from the pgadmin4-web Debian package: that package depends on apache2, which would contend
# with nginx for ports 80/443 on this box. Version is pinned; pip verifies the wheel's hash against
# PyPI's index, which is why there is no separate sha256 here as there is for the two PHP tools.
readonly PGADMIN_VERSION=9.17
readonly PGADMIN_PORT=5050
readonly PGADMIN_ADMIN_EMAIL_LOCALPART=admin
# Flask-Security-Too must be held at 5.8.1. pgAdmin 9.17 declares `Flask-Security-Too==5.8.*`, so
# pip resolves 5.8.2 — and 5.8.2 inverted the meaning of UserMixin.is_locked():
#
#   5.8.1  LoginForm.validate():  if not self.user.is_locked(errors): return False
#   5.8.2  LoginForm.validate():  if     self.user.is_locked(errors): return False
#
# pgAdmin's own User.is_locked() returns True to mean "not locked, proceed" (see its comment in
# pgadmin/model/__init__.py), which matches 5.8.1. Under 5.8.2 an UNLOCKED account is read as
# locked, so validate() fails for everyone — and it fails *silently*, because pgAdmin only appends
# the "account is locked" message on its other branch. The visible symptom is a correct password
# bouncing straight back to the login page with no error at all, which looks exactly like a broken
# session. Verified by tracing flask_security/forms.py to the failing line.
#
# Drop this pin only after confirming pgAdmin's is_locked() convention matches the release.
readonly PGADMIN_FLASK_SECURITY_VERSION=5.8.1

log() {
  echo "install.sh: $*"
}

die() {
  echo "install.sh: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------

check_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    die "must be run as root (e.g. sudo ./setup/install.sh)"
  fi
}

check_ubuntu() {
  local id="" version_id=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck source=/dev/null
    source /etc/os-release
    id="${ID:-}"
    version_id="${VERSION_ID:-}"
  fi
  if [[ "$id" != "ubuntu" || "$version_id" != "24.04" ]]; then
    log "WARNING: this script targets Ubuntu 24.04; detected '${id:-unknown} ${version_id:-unknown}'. Continuing anyway."
  fi
}

readonly MIN_FREE_DISK_MB=2048

# Fails loudly if / has less than MIN_FREE_DISK_MB free. PHP 8.1-8.4 (with
# extensions) + MySQL + PostgreSQL + Node x3 + the Shipway build easily need
# more than this; better to stop now than fail halfway through apt or npm
# with a confusing ENOSPC.
check_disk_space() {
  local avail_kb avail_mb
  avail_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
  avail_mb=$((avail_kb / 1024))
  if ((avail_mb < MIN_FREE_DISK_MB)); then
    die "only ${avail_mb}MiB free on / — at least ${MIN_FREE_DISK_MB}MiB is required. Free up space (or resize the disk) and re-run."
  fi
  log "disk space check passed (${avail_mb}MiB free on /)"
}

# Fails loudly if port 80 or 443 is already held by something other than
# nginx (which install_base_packages is about to install and which install_vhosts
# needs those ports for). A fresh box should have both free; a re-run will
# see nginx itself holding them, which is fine. Skips gracefully if `ss`
# isn't on PATH rather than failing preflight over a missing diagnostic tool.
check_ports() {
  if ! command -v ss >/dev/null 2>&1; then
    log "WARNING: 'ss' not found, skipping the port 80/443 preflight check"
    return
  fi

  local port line
  for port in 80 443; do
    line="$(ss -Htlnp "sport = :${port}" 2>/dev/null || true)"
    if [[ -z "$line" ]]; then
      continue
    fi
    if [[ "$line" == *'"nginx"'* ]]; then
      log "port ${port} is already held by nginx, continuing"
      continue
    fi
    die "port ${port} is already in use by something other than nginx: ${line}. Stop that process/service before installing Shipway (nginx needs 80 and 443 free)."
  done
  log "port 80/443 check passed"
}

# Fails loudly if outbound DNS or HTTPS isn't working — every remaining step
# (apt, the ondrej/php PPA, nodejs.org, GitHub releases for mailpit,
# Cloudflare, Let's Encrypt) needs both.
check_outbound_connectivity() {
  if ! getent hosts api.cloudflare.com >/dev/null 2>&1; then
    die "outbound DNS resolution isn't working (couldn't resolve api.cloudflare.com). Check /etc/resolv.conf and the network/firewall configuration, then re-run."
  fi
  if ! curl -sS --max-time 10 -o /dev/null https://api.cloudflare.com/; then
    die "outbound HTTPS isn't reachable (couldn't reach https://api.cloudflare.com/). The installer needs outbound internet access for apt, Node, Mailpit, Cloudflare, and Let's Encrypt. Check firewall/proxy settings, then re-run."
  fi
  log "outbound DNS/HTTPS connectivity check passed"
}

# True if `host` has an A record resolving to `ip`.
dns_resolves_to() {
  local host="$1" ip="$2"
  getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | grep -qxF "$ip"
}

# Warns (rather than fails) if BASE_DOMAIN/*.BASE_DOMAIN don't yet resolve to
# SERVER_IP: certbot's DNS-01 challenge doesn't need this (it posts a TXT
# record via the Cloudflare API, not an HTTP/TLS check), but the nginx
# vhosts install_vhosts renders do — https://ship.<base-domain> won't be
# reachable until DNS points here. Requires typed confirmation to proceed
# unless SHIPWAY_NONINTERACTIVE=1, for a non-interactive/scripted install.
check_dns_resolution() {
  local probe_host="shipway-preflight-probe.${BASE_DOMAIN}"

  if dns_resolves_to "$BASE_DOMAIN" "$SERVER_IP" && dns_resolves_to "$probe_host" "$SERVER_IP"; then
    log "DNS check passed: ${BASE_DOMAIN} and *.${BASE_DOMAIN} both resolve to ${SERVER_IP}"
    return
  fi

  log "WARNING: DNS doesn't fully point at this server yet."
  log "  ${BASE_DOMAIN} A record: $(getent ahostsv4 "$BASE_DOMAIN" 2>/dev/null | awk '{print $1}' | paste -sd, - || true)"
  log "  *.${BASE_DOMAIN} (wildcard probe) A record: $(getent ahostsv4 "$probe_host" 2>/dev/null | awk '{print $1}' | paste -sd, - || true)"
  log "  expected: ${SERVER_IP}"
  log "This usually just means the DNS records haven't propagated yet, or the wildcard A record hasn't been created — see DEPLOYMENT.md's prerequisites. The install can continue (certbot's DNS-01 challenge doesn't need this), but https://ship.${BASE_DOMAIN} won't be reachable until DNS is correct."

  if [[ "${SHIPWAY_NONINTERACTIVE:-}" == "1" ]]; then
    log "SHIPWAY_NONINTERACTIVE=1 set, continuing without confirmation"
    return
  fi

  local reply=""
  read -r -p "Continue anyway? [y/N] " reply
  if [[ ! "$reply" =~ ^[Yy]$ ]]; then
    die "aborted. Point ${BASE_DOMAIN} and *.${BASE_DOMAIN} at ${SERVER_IP} (A records) and re-run, or re-run with SHIPWAY_NONINTERACTIVE=1 to proceed anyway."
  fi
}

# ---------------------------------------------------------------------------
# Small helpers used throughout
# ---------------------------------------------------------------------------

# 24 random bytes as 48 lowercase hex chars. Avoids piping through `head`
# (which SIGPIPEs the upstream reader and, under `pipefail`, would abort the
# whole script) by reading an exact byte count from /dev/urandom instead.
random_secret() {
  od -An -tx1 -N24 /dev/urandom | tr -d ' \n'
}

# Returns the value for $1 from $SECRETS_FILE, generating and persisting a
# new random one on first use. Re-running install.sh must never rotate a
# credential a project's env or the running server may already hold.
get_or_create_secret() {
  local name="$1"
  local existing
  existing="$(grep -m1 "^${name}=" "$SECRETS_FILE" 2>/dev/null | cut -d= -f2- || true)"
  if [[ -n "$existing" ]]; then
    printf '%s' "$existing"
    return
  fi
  local value
  value="$(random_secret)"
  echo "${name}=${value}" >> "$SECRETS_FILE"
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# 1. apt packages: nginx/git/curl/acl/unzip + the ondrej/php PPA + PHP
#    8.1-8.4 + composer
# ---------------------------------------------------------------------------

install_base_packages() {
  log "apt-get update"
  apt-get update -y

  log "installing base packages"
  apt-get install -y \
    nginx git curl acl unzip build-essential \
    software-properties-common rsync jq ca-certificates
}

install_php() {
  log "adding ppa:ondrej/php"
  add-apt-repository -y ppa:ondrej/php
  apt-get update -y

  local php_packages=()
  local v ext
  for v in "${PHP_VERSIONS[@]}"; do
    for ext in "${PHP_EXTENSIONS[@]}"; do
      php_packages+=("php${v}-${ext}")
    done
  done

  log "installing PHP ${PHP_VERSIONS[*]} (${PHP_EXTENSIONS[*]})"
  apt-get install -y "${php_packages[@]}"
}

# Creates /opt/php/<version>/bin/php -> /usr/bin/php<version> for every installed PHP version, so a
# project's install/build/pre-post-deploy scripts and worker commands can put that directory first
# on PATH (server/src/services/provisioner.ts's phpBinDir) and have a bare `php` invocation resolve
# to the project's pinned version, instead of whichever version ondrej/php's PPA currently makes the
# unversioned `/usr/bin/php` default. Idempotent: `install -d` and `ln -sf` both just re-assert the
# same state on a re-run.
install_php_bin_shims() {
  log "creating /opt/php/<version>/bin php shims"
  local v
  for v in "${PHP_VERSIONS[@]}"; do
    install -d -m 0755 "/opt/php/${v}/bin"
    ln -sf "/usr/bin/php${v}" "/opt/php/${v}/bin/php"
  done
}

install_composer() {
  if [[ -x /usr/local/bin/composer ]]; then
    log "composer already installed, skipping"
    return
  fi

  log "installing composer"
  local tmp_dir installer expected_sig actual_sig
  tmp_dir="$(mktemp -d)"
  installer="${tmp_dir}/composer-setup.php"

  curl -fsSL -o "$installer" https://getcomposer.org/installer
  expected_sig="$(curl -fsSL https://composer.github.io/installer.sig)"
  actual_sig="$(php -r "echo hash_file('sha384', '${installer}');")"
  if [[ "$actual_sig" != "$expected_sig" ]]; then
    rm -rf "$tmp_dir"
    die "composer installer signature mismatch (expected ${expected_sig}, got ${actual_sig})"
  fi

  php "$installer" --quiet --install-dir=/usr/local/bin --filename=composer
  rm -rf "$tmp_dir"
}

# ---------------------------------------------------------------------------
# 2. MySQL, PostgreSQL, Redis
# ---------------------------------------------------------------------------

install_databases() {
  log "installing mysql-server, postgresql, redis-server"
  apt-get install -y mysql-server postgresql redis-server
}

configure_redis() {
  local conf=/etc/redis/redis.conf
  local marker="# shipway-managed requirepass"

  if grep -qF "$marker" "$conf"; then
    log "redis requirepass already configured, skipping"
    # Recover the password actually in effect (redis.conf is the source of
    # truth) into the secrets cache if it's missing there — e.g. the secrets
    # file was lost/reset on an already-provisioned box. Without this,
    # write_bootstrap_file's later `get_or_create_secret REDIS_PASSWORD`
    # would mint a new value that doesn't match what redis-server is
    # actually running with.
    if ! grep -q "^REDIS_PASSWORD=" "$SECRETS_FILE" 2>/dev/null; then
      local existing_password
      existing_password="$(grep -A1 -F "$marker" "$conf" | grep '^requirepass ' | head -n1 | cut -d' ' -f2-)"
      if [[ -n "$existing_password" ]]; then
        echo "REDIS_PASSWORD=${existing_password}" >> "$SECRETS_FILE"
      fi
    fi
    return
  fi

  log "setting redis requirepass"
  local password
  password="$(get_or_create_secret REDIS_PASSWORD)"
  {
    echo ""
    echo "$marker"
    echo "requirepass ${password}"
  } >> "$conf"
  systemctl restart redis-server
}

# ---------------------------------------------------------------------------
# 3. Node 18/20/22 -> /opt/node/<major>
# ---------------------------------------------------------------------------

install_node() {
  local major="$1"
  local target_dir="/opt/node/${major}"

  if [[ -x "${target_dir}/bin/node" ]]; then
    log "/opt/node/${major} already installed, skipping"
    return
  fi

  log "installing Node ${major} to ${target_dir}"
  local dist_url="https://nodejs.org/dist/latest-v${major}.x"
  local shasums filename expected_sha
  shasums="$(curl -fsSL "${dist_url}/SHASUMS256.txt")"
  filename="$(printf '%s\n' "$shasums" | awk '{print $2}' | grep -E "^node-v${major}\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz\$" | head -n1)"
  if [[ -z "$filename" ]]; then
    die "could not find a linux-x64 tarball for Node ${major} in ${dist_url}/SHASUMS256.txt"
  fi
  expected_sha="$(printf '%s\n' "$shasums" | grep -F " ${filename}" | awk '{print $1}')"

  local tmp_dir actual_sha
  tmp_dir="$(mktemp -d)"
  curl -fsSL -o "${tmp_dir}/${filename}" "${dist_url}/${filename}"
  actual_sha="$(sha256sum "${tmp_dir}/${filename}" | awk '{print $1}')"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    rm -rf "$tmp_dir"
    die "sha256 mismatch for ${filename}: expected ${expected_sha}, got ${actual_sha}"
  fi

  mkdir -p "$target_dir"
  tar -xJf "${tmp_dir}/${filename}" -C "$target_dir" --strip-components=1
  rm -rf "$tmp_dir"
}

install_all_node_versions() {
  local v
  for v in "${NODE_VERSIONS[@]}"; do
    install_node "$v"
  done
}

# ---------------------------------------------------------------------------
# 4. Mailpit
# ---------------------------------------------------------------------------

install_mailpit_binary() {
  if [[ -x /usr/local/bin/mailpit ]]; then
    log "mailpit already installed, skipping"
    return
  fi

  log "installing mailpit"
  local asset_url
  asset_url="$(curl -fsSL https://api.github.com/repos/axllent/mailpit/releases/latest \
    | jq -r '.assets[] | select(.name | test("linux.*amd64.*tar\\.gz$"; "i")) | .browser_download_url' \
    | head -n1)"
  if [[ -z "$asset_url" ]]; then
    die "could not find a linux/amd64 mailpit release asset"
  fi

  local tmp_dir binary
  tmp_dir="$(mktemp -d)"
  curl -fsSL -o "${tmp_dir}/mailpit.tar.gz" "$asset_url"
  tar -xzf "${tmp_dir}/mailpit.tar.gz" -C "$tmp_dir"
  binary="$(find "$tmp_dir" -type f -name mailpit | head -n1)"
  if [[ -z "$binary" ]]; then
    rm -rf "$tmp_dir"
    die "mailpit binary not found in downloaded archive"
  fi

  install -m 0755 -o root -g root "$binary" /usr/local/bin/mailpit
  rm -rf "$tmp_dir"
}

install_mailpit_unit() {
  log "installing mailpit.service"
  cat > /etc/systemd/system/mailpit.service <<'EOF'
[Unit]
Description=Mailpit SMTP + web UI (shared catch-all mailbox for Shipway projects)
After=network.target

[Service]
Type=simple
DynamicUser=yes
ExecStart=/usr/local/bin/mailpit --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 /etc/systemd/system/mailpit.service
  systemctl daemon-reload
  systemctl enable --now mailpit
}

MAILPIT_WEB_PASSWORD=""

# Generates (and caches, like every other secret) a random password for the Mailpit web UI's HTTP
# basic auth, and writes the htpasswd file the nginx-mailpit.conf vhost's auth_basic_user_file
# points at. Idempotent: the password is cached via get_or_create_secret, and the htpasswd file
# itself is only written once (its content is otherwise not deterministic — `openssl passwd -apr1`
# picks a fresh salt every call — so re-writing it on every run would fail the spirit of "never
# rotate a credential something may already depend on" even though the password stays the same).
configure_mailpit_auth() {
  MAILPIT_WEB_PASSWORD="$(get_or_create_secret MAILPIT_WEB_PASSWORD)"

  local htpasswd_file=/etc/nginx/shipway-mailpit.htpasswd
  if [[ -f "$htpasswd_file" ]]; then
    log "mailpit htpasswd already exists, skipping"
    return
  fi

  log "writing mailpit htpasswd (user: intcore)"
  local hash
  hash="$(openssl passwd -apr1 "$MAILPIT_WEB_PASSWORD")"
  echo "intcore:${hash}" > "$htpasswd_file"
  chmod 0644 "$htpasswd_file"
}

# Extracts phpMyAdmin to /opt/phpmyadmin and writes its config. Served under a path on the
# dashboard vhost (ship.<base-domain>/db/phpmyadmin), gated by the Shipway session — see the
# auth_request block in templates/nginx-dashboard.conf — so it has no login of its own to guard and
# no basic-auth prompt in front of it.
#
# Idempotent via a version stamp: an existing install of the same version is left alone rather than
# re-extracted, so a re-run never disturbs a working console.
install_phpmyadmin() {
  local dest=/opt/phpmyadmin
  local stamp="${dest}/.shipway-version"

  if [[ -f "$stamp" ]] && [[ "$(cat "$stamp")" == "$PMA_VERSION" ]]; then
    log "phpMyAdmin ${PMA_VERSION} already installed, skipping"
    return
  fi

  log "installing phpMyAdmin ${PMA_VERSION}"
  local tmp tarball
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  tarball="${tmp}/pma.tar.gz"

  curl -fsSL --retry 3 -o "$tarball" \
    "https://files.phpmyadmin.net/phpMyAdmin/${PMA_VERSION}/phpMyAdmin-${PMA_VERSION}-english.tar.gz" \
    || die "failed to download phpMyAdmin ${PMA_VERSION}"
  echo "${PMA_SHA256}  ${tarball}" | sha256sum --check --status \
    || die "phpMyAdmin checksum mismatch: expected ${PMA_SHA256}, got $(sha256sum "$tarball" | cut -d' ' -f1). Refusing to extract PHP that will run with database access."

  tar -xzf "$tarball" -C "$tmp"
  rm -rf "$dest"
  mv "${tmp}/phpMyAdmin-${PMA_VERSION}-english" "$dest"
  chown -R root:root "$dest"
  # www-data only ever reads the application itself; the one writable path is TempDir below.
  find "$dest" -type d -exec chmod 0755 {} +
  find "$dest" -type f -exec chmod 0644 {} +

  # Templates are compiled at runtime, and TempDir is the only place phpMyAdmin needs to write.
  install -d -m 0750 -o www-data -g www-data /var/lib/phpmyadmin/tmp

  configure_phpmyadmin
  echo "$PMA_VERSION" > "$stamp"
}

# Writes /opt/phpmyadmin/config.inc.php. The blowfish secret encrypts the cookie holding the
# database password in the browser, so it is generated once and cached like every other secret —
# rotating it on a re-run would silently invalidate every open session.
configure_phpmyadmin() {
  local secret
  secret="$(get_or_create_secret PMA_BLOWFISH_SECRET)"

  log "writing phpMyAdmin config.inc.php"
  cat > /opt/phpmyadmin/config.inc.php <<PMACONF
<?php
// Written by setup/install.sh — edits here are overwritten on the next install.
\$cfg['blowfish_secret'] = '${secret}';

\$i = 0;
\$i++;
// 127.0.0.1 rather than 'localhost': a TCP connection is what Shipway's own connection strings use
// (see server/src/services/dbprovision.ts), so grants that work for a project also work here.
\$cfg['Servers'][\$i]['host'] = '127.0.0.1';
\$cfg['Servers'][\$i]['port'] = 3306;
\$cfg['Servers'][\$i]['auth_type'] = 'cookie';
\$cfg['Servers'][\$i]['AllowNoPassword'] = false;
// No root/passwordless shortcut: whoever opens this supplies a database account, so what they can
// reach is bounded by that account's own grants.
\$cfg['Servers'][\$i]['AllowRoot'] = false;

\$cfg['TempDir'] = '/var/lib/phpmyadmin/tmp';
// Served under a path, not at a host root — phpMyAdmin needs to know its own base URL to build
// redirects correctly behind the reverse proxy.
\$cfg['PmaAbsoluteUri'] = 'https://ship.${BASE_DOMAIN}/db/phpmyadmin/';
PMACONF

  chown root:root /opt/phpmyadmin/config.inc.php
  # Readable by the FPM worker, not by other local users: it carries the blowfish secret.
  chmod 0640 /opt/phpmyadmin/config.inc.php
  chgrp www-data /opt/phpmyadmin/config.inc.php
}

PGADMIN_ADMIN_PASSWORD=""
PGADMIN_ADMIN_EMAIL=""

# Installs pgAdmin 4 into a self-contained venv, initialises its config database with one
# Administrator account, and runs it under gunicorn as pgadmin.service. Reachability is gated by
# nginx's auth_request against the Shipway session (see templates/nginx-dashboard.conf), and
# pgAdmin's own login sits behind that.
#
# Runs as its own `pgadmin` system user, not www-data: its SQLite database holds any connection
# passwords a user chooses to save, and a php-fpm compromise should not be able to read them.
install_pgadmin() {
  PGADMIN_ADMIN_EMAIL="${PGADMIN_ADMIN_EMAIL_LOCALPART}@${BASE_DOMAIN}"
  PGADMIN_ADMIN_PASSWORD="$(get_or_create_secret PGADMIN_ADMIN_PASSWORD)"

  local venv=/opt/pgadmin/venv
  local pkg

  if [[ ! -x "${venv}/bin/python" ]]; then
    log "creating pgAdmin venv"
    apt-get install -y python3-venv python3-dev
    install -d -m 0755 -o root -g root /opt/pgadmin
    python3 -m venv "$venv"
    "${venv}/bin/pip" install --quiet --upgrade pip wheel
  fi

  # `gevent` is not a pgAdmin dependency but is required by the worker class the service uses:
  # pgAdmin's query tool and ERD talk over SocketIO, which the default sync worker cannot serve.
  if ! "${venv}/bin/pip" show "pgadmin4" >/dev/null 2>&1 \
    || [[ "$("${venv}/bin/pip" show pgadmin4 2>/dev/null | awk '/^Version:/{print $2}')" != "$PGADMIN_VERSION" ]]; then
    log "installing pgAdmin ${PGADMIN_VERSION} (large — a few minutes)"
    "${venv}/bin/pip" install --quiet "pgadmin4==${PGADMIN_VERSION}" gunicorn gevent \
      || die "pip failed to install pgadmin4==${PGADMIN_VERSION}"
  else
    log "pgAdmin ${PGADMIN_VERSION} already installed, skipping"
  fi

  # Applied on every run, not just a fresh install: pgAdmin's own dependency range lets pip pull the
  # incompatible 5.8.2 on any later reinstall or upgrade. See the note on
  # PGADMIN_FLASK_SECURITY_VERSION above for what breaks.
  local fs_installed
  fs_installed="$("${venv}/bin/pip" show flask-security-too 2>/dev/null | awk '/^Version:/{print $2}')"
  if [[ "$fs_installed" != "$PGADMIN_FLASK_SECURITY_VERSION" ]]; then
    log "pinning Flask-Security-Too to ${PGADMIN_FLASK_SECURITY_VERSION} (found ${fs_installed:-none}; 5.8.2 breaks pgAdmin login)"
    "${venv}/bin/pip" install --quiet "Flask-Security-Too==${PGADMIN_FLASK_SECURITY_VERSION}" \
      || die "failed to pin Flask-Security-Too==${PGADMIN_FLASK_SECURITY_VERSION}; pgAdmin login would silently reject every password."
  fi

  # Ask the venv's own interpreter where site-packages is, so this does not break on a different
  # python minor version than the one that happened to be current when this was written.
  pkg="$("${venv}/bin/python" -c 'import os, sysconfig; print(os.path.join(sysconfig.get_paths()["purelib"], "pgadmin4"))')"
  [[ -f "${pkg}/pgAdmin4.py" ]] || die "pgAdmin install looks wrong: ${pkg}/pgAdmin4.py not found"

  if ! id -u pgadmin >/dev/null 2>&1; then
    log "creating pgadmin system user"
    useradd --system --home-dir /var/lib/pgadmin --shell /usr/sbin/nologin pgadmin
  fi
  install -d -m 0700 -o pgadmin -g pgadmin /var/lib/pgadmin
  install -d -m 0750 -o pgadmin -g pgadmin /var/log/pgadmin

  install -m 0644 -o root -g root "${SCRIPT_DIR}/pgadmin-config-local.py" "${pkg}/config_local.py"

  # setup-db is idempotent-ish but only creates the first user when the database does not exist;
  # skipping it on an existing database is what keeps a re-run from touching live accounts.
  if [[ ! -f /var/lib/pgadmin/pgadmin4.db ]]; then
    log "initialising pgAdmin config database (admin: ${PGADMIN_ADMIN_EMAIL})"
    ( cd "$pkg" && PGADMIN_SETUP_EMAIL="$PGADMIN_ADMIN_EMAIL" PGADMIN_SETUP_PASSWORD="$PGADMIN_ADMIN_PASSWORD" \
      sudo -u pgadmin -E "${venv}/bin/python" setup.py setup-db ) \
      || die "pgAdmin setup-db failed"
  else
    log "pgAdmin config database already exists, skipping setup-db"
  fi

  # Set the password explicitly, every run, and verify it. setup-db's
  # PGADMIN_SETUP_PASSWORD and `setup.py update-user --password` both reported success on 9.17
  # while leaving the stored hash unchanged, producing an account whose password nobody knew —
  # and pgAdmin's login view fails that case with a bare redirect back to the login form, no
  # message, so it looks like a broken session rather than a bad credential. This script hashes
  # through Flask-Security (which peppers with SECURITY_PASSWORD_SALT, so it cannot be done
  # outside the app context) and re-reads the row to confirm before returning.
  # Copied out of the checkout first: the checkout normally lives under /root, which the pgadmin
  # user cannot read. The password goes over stdin, not argv, so it never shows up in ps.
  install -m 0755 -o root -g root "${SCRIPT_DIR}/pgadmin-set-password.py" /opt/pgadmin/set-password.py
  log "setting pgAdmin admin password for ${PGADMIN_ADMIN_EMAIL}"
  ( cd "$pkg" && printf '%s\n' "$PGADMIN_ADMIN_PASSWORD" \
      | sudo -u pgadmin "${venv}/bin/python" /opt/pgadmin/set-password.py "$PGADMIN_ADMIN_EMAIL" >/dev/null ) \
    || die "failed to set the pgAdmin admin password — the account would be unusable, so stopping here rather than finishing with a console nobody can log into."

  log "installing pgadmin.service"
  sed "s|\${PGADMIN_DIR}|${pkg}|g; s|127.0.0.1:5050|127.0.0.1:${PGADMIN_PORT}|g" \
    "${SCRIPT_DIR}/pgadmin.service" > /etc/systemd/system/pgadmin.service
  chmod 0644 /etc/systemd/system/pgadmin.service
  systemctl daemon-reload
  systemctl enable pgadmin
  systemctl restart pgadmin
}

# ---------------------------------------------------------------------------
# 5. certbot
# ---------------------------------------------------------------------------

install_certbot() {
  log "installing certbot + cloudflare dns plugin"
  apt-get install -y certbot python3-certbot-dns-cloudflare
}

# ---------------------------------------------------------------------------
# 6. deployer user, dirs, sysops helper + sudoers
# ---------------------------------------------------------------------------

create_deployer_user() {
  if id -u deployer >/dev/null 2>&1; then
    log "deployer user already exists, skipping"
  else
    log "creating deployer system user"
    useradd --system --create-home --home-dir "$DEPLOYER_HOME" --shell /bin/bash deployer
  fi

  install -d -m 0751 -o deployer -g deployer /var/deploy/apps
  install -d -m 0750 -o deployer -g deployer /var/deploy/logs
  install -d -m 0750 -o deployer -g deployer /var/lib/shipway

  # Per-project basic-auth files (auth_basic_user_file) live here — root-owned, written only via
  # shipway-sysops' whitelist. 0755 so nginx's worker can read a file it is pointed at.
  install -d -m 0755 -o root -g root /etc/nginx/shipway-auth

  # nginx runs as www-data and has to traverse $DEPLOYER_HOME and apps/ to serve a project's
  # files, which sit at 0755 under apps/<slug>/releases/. 0750 on either directory makes every
  # static vhost fail with "stat() failed (13: Permission denied)" no matter how the release
  # itself is permissioned. 0751 is traverse-but-not-list: www-data can walk a path it already
  # knows from the vhost's `root`, but cannot enumerate these directories, and logs/ plus
  # /var/lib/shipway (secret.key, the SQLite database) stay 0750 — unreadable by www-data.
  chmod 0751 "$DEPLOYER_HOME" /var/deploy/apps

  # deployer needs to read the systemd journal (no sudo) for `journalctl -u`
  # log tailing (see server/src/sysops/real.ts's journalTail).
  usermod -aG systemd-journal deployer
}

install_sysops_helper() {
  log "installing /usr/local/bin/shipway-sysops"
  install -m 0755 -o root -g root "${SCRIPT_DIR}/shipway-sysops" /usr/local/bin/shipway-sysops

  log "validating and installing sudoers.d-shipway"
  local tmp
  tmp="$(mktemp)"
  cp "${SCRIPT_DIR}/sudoers.d-shipway" "$tmp"
  if ! visudo -c -f "$tmp"; then
    rm -f "$tmp"
    die "sudoers.d-shipway failed visudo validation, aborting before installing it"
  fi
  install -m 0440 -o root -g root "$tmp" /etc/sudoers.d/shipway-sysops
  rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# 7. Prompts (env-var overridable, for non-interactive installs)
# ---------------------------------------------------------------------------

BASE_DOMAIN=""
SERVER_IP=""
CF_API_TOKEN=""
ACME_EMAIL=""

read_prompts() {
  BASE_DOMAIN="${SHIPWAY_BASE_DOMAIN:-}"
  if [[ -z "$BASE_DOMAIN" ]]; then
    read -r -p "Base domain (e.g. intcore.dev): " BASE_DOMAIN
  fi

  SERVER_IP="${SHIPWAY_SERVER_IP:-}"
  if [[ -z "$SERVER_IP" ]]; then
    read -r -p "Server public IP: " SERVER_IP
  fi

  CF_API_TOKEN="${SHIPWAY_CF_API_TOKEN:-}"
  if [[ -z "$CF_API_TOKEN" ]]; then
    read -r -s -p "Cloudflare API token (Zone:Read + DNS:Edit): " CF_API_TOKEN
    echo
  fi

  ACME_EMAIL="${SHIPWAY_ACME_EMAIL:-}"
  if [[ -z "$ACME_EMAIL" ]]; then
    read -r -p "ACME/Let's Encrypt contact email: " ACME_EMAIL
  fi

  if [[ -z "$BASE_DOMAIN" || -z "$SERVER_IP" || -z "$CF_API_TOKEN" || -z "$ACME_EMAIL" ]]; then
    die "BASE_DOMAIN, SERVER_IP, CF_API_TOKEN and ACME_EMAIL are all required"
  fi
}

# Thin wrapper: every Cloudflare API call the installer makes (token verify,
# zone lookup, DNS record create/find) goes through this, authenticated with
# the operator's CF_API_TOKEN.
cf_api() {
  curl -fsSL -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" "$@"
}

# The zone id for BASE_DOMAIN, resolved once by verify_cloudflare_access and
# reused by configure_dns later — one lookup instead of two, and one place
# that can fail with a clear message instead of two.
ZONE_ID=""

# Fails loudly, before any package is installed, if the Cloudflare token is
# invalid/expired or can't see a zone named BASE_DOMAIN — the single most
# common way this installer goes wrong, and worth catching immediately
# rather than after certbot (or worse, after MySQL/Postgres accounts,
# bootstrap.json, and the build) fails on it instead.
verify_cloudflare_access() {
  log "verifying Cloudflare API token"

  local verify_body verify_ok
  verify_body="$(cf_api "https://api.cloudflare.com/client/v4/user/tokens/verify" 2>/dev/null || true)"
  verify_ok="$(printf '%s' "$verify_body" | jq -r '(.success == true and .result.status == "active")' 2>/dev/null || echo false)"
  if [[ "$verify_ok" != "true" ]]; then
    die "the Cloudflare API token is invalid, expired, or unreachable. Create a token with Zone:Read + DNS:Edit permission covering ${BASE_DOMAIN} (Cloudflare dashboard: My Profile > API Tokens > Create Token > \"Edit zone DNS\" template, restricted to that zone), then re-run with the new token."
  fi

  # `|| true` (matching verify_body above): under `set -o pipefail`, a curl-level failure here
  # (rare — the token was just confirmed active above; this would mean a transient network/API
  # error) would otherwise make THIS assignment itself exit nonzero and trip `set -e` immediately,
  # skipping the die() below in favor of a bare, unhelpful curl error.
  ZONE_ID="$(cf_api "https://api.cloudflare.com/client/v4/zones?name=${BASE_DOMAIN}" 2>/dev/null | jq -r '.result[0].id // empty' 2>/dev/null || true)"
  if [[ -z "$ZONE_ID" ]]; then
    die "no Cloudflare zone named '${BASE_DOMAIN}' is visible to this token (or the lookup itself failed — check connectivity to api.cloudflare.com). Check that ${BASE_DOMAIN} is added to this Cloudflare account as its own zone (not a subdomain of another zone) and that the token's zone resource includes it, then re-run."
  fi

  log "Cloudflare access verified (zone ${ZONE_ID} for ${BASE_DOMAIN})"
}

# ---------------------------------------------------------------------------
# 8. Wildcard cert via certbot + Cloudflare DNS-01
# ---------------------------------------------------------------------------

issue_certificate() {
  install -d -m 0700 /root/.secrets
  local cf_ini=/root/.secrets/certbot-cloudflare.ini
  cat > "$cf_ini" <<EOF
dns_cloudflare_api_token = ${CF_API_TOKEN}
EOF
  chmod 0600 "$cf_ini"

  local cert_dir="/etc/letsencrypt/live/${BASE_DOMAIN}"
  if [[ -d "$cert_dir" ]]; then
    log "certificate for ${BASE_DOMAIN} already exists, skipping certbot"
  else
    log "requesting wildcard certificate for *.${BASE_DOMAIN} / ${BASE_DOMAIN}"
    if ! certbot certonly \
      --dns-cloudflare \
      --dns-cloudflare-credentials "$cf_ini" \
      --dns-cloudflare-propagation-seconds 30 \
      -d "*.${BASE_DOMAIN}" \
      -d "${BASE_DOMAIN}" \
      --cert-name "${BASE_DOMAIN}" \
      --agree-tos \
      -m "$ACME_EMAIL" \
      -n; then
      die "certbot failed to issue a certificate for *.${BASE_DOMAIN} / ${BASE_DOMAIN} — see the certbot output above for the exact reason. Common causes: the Cloudflare token lost DNS:Edit access between verify_cloudflare_access and here, or 30s wasn't long enough for the TXT record to propagate (rare). Fix it and re-run install.sh; already-completed steps are skipped, so this is safe to retry."
    fi
  fi

  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
systemctl reload nginx
EOF
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
}

# ---------------------------------------------------------------------------
# 9. MySQL / Postgres admin accounts for Shipway
# ---------------------------------------------------------------------------

MYSQL_ADMIN_PASSWORD=""
POSTGRES_ADMIN_PASSWORD=""

provision_mysql_admin() {
  MYSQL_ADMIN_PASSWORD="$(get_or_create_secret MYSQL_ADMIN_PASSWORD)"
  log "provisioning MySQL shipway_admin user"
  # Granted at both hosts — see the file header comment for why. The
  # trailing ALTER USERs are not redundant with CREATE USER IF NOT EXISTS:
  # if the account already existed, CREATE's IDENTIFIED BY clause is a
  # no-op, so without the ALTER the account's real password could drift
  # from whatever get_or_create_secret just returned (e.g. if
  # /root/.shipway-install-secrets was ever lost and regenerated) — leaving
  # bootstrap.json reporting a password that doesn't actually work.
  mysql -u root <<SQL
CREATE USER IF NOT EXISTS 'shipway_admin'@'localhost' IDENTIFIED BY '${MYSQL_ADMIN_PASSWORD}';
CREATE USER IF NOT EXISTS 'shipway_admin'@'127.0.0.1' IDENTIFIED BY '${MYSQL_ADMIN_PASSWORD}';
ALTER USER 'shipway_admin'@'localhost' IDENTIFIED BY '${MYSQL_ADMIN_PASSWORD}';
ALTER USER 'shipway_admin'@'127.0.0.1' IDENTIFIED BY '${MYSQL_ADMIN_PASSWORD}';
GRANT ALL ON *.* TO 'shipway_admin'@'localhost' WITH GRANT OPTION;
GRANT ALL ON *.* TO 'shipway_admin'@'127.0.0.1' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL
}

provision_postgres_admin() {
  POSTGRES_ADMIN_PASSWORD="$(get_or_create_secret POSTGRES_ADMIN_PASSWORD)"
  log "provisioning Postgres shipway_admin role"
  local exists
  exists="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='shipway_admin'")"
  if [[ "$exists" == "1" ]]; then
    # Same reasoning as the MySQL ALTER USERs above: always (re)assert the
    # password so it can never drift from what bootstrap.json reports.
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
      "ALTER ROLE shipway_admin WITH PASSWORD '${POSTGRES_ADMIN_PASSWORD}'"
  else
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
      "CREATE ROLE shipway_admin LOGIN CREATEDB CREATEROLE PASSWORD '${POSTGRES_ADMIN_PASSWORD}'"
  fi
}

# ---------------------------------------------------------------------------
# 10. bootstrap.json — imported once by the server on first boot (see
#     server/src/lib/bootstrap.ts) and then deleted.
# ---------------------------------------------------------------------------

write_bootstrap_file() {
  log "writing /var/lib/shipway/bootstrap.json"
  local redis_password
  redis_password="$(get_or_create_secret REDIS_PASSWORD)"

  local mysql_admin_url="mysql://shipway_admin:${MYSQL_ADMIN_PASSWORD}@127.0.0.1:3306"
  local postgres_admin_url="postgres://shipway_admin:${POSTGRES_ADMIN_PASSWORD}@127.0.0.1:5432/postgres"
  local mailpit_web_url="https://mail.${BASE_DOMAIN}"

  install -d -m 0750 -o deployer -g deployer /var/lib/shipway
  jq -n \
    --arg mysql_admin_url "$mysql_admin_url" \
    --arg postgres_admin_url "$postgres_admin_url" \
    --arg redis_host "127.0.0.1" \
    --argjson redis_port 6379 \
    --arg redis_password "$redis_password" \
    --arg mailpit_smtp_host "127.0.0.1" \
    --argjson mailpit_smtp_port 1025 \
    --arg mailpit_web_url "$mailpit_web_url" \
    --arg mailpit_username "intcore" \
    --arg mailpit_web_password "$MAILPIT_WEB_PASSWORD" \
    --arg base_domain "$BASE_DOMAIN" \
    --arg server_ip "$SERVER_IP" \
    --arg acme_email "$ACME_EMAIL" \
    '{
      mysql_admin_url: $mysql_admin_url,
      postgres_admin_url: $postgres_admin_url,
      redis_info: { host: $redis_host, port: $redis_port, password: $redis_password },
      mailpit_info: { smtpHost: $mailpit_smtp_host, smtpPort: $mailpit_smtp_port, webUrl: $mailpit_web_url, username: $mailpit_username, webPassword: $mailpit_web_password },
      base_domain: $base_domain,
      server_ip: $server_ip,
      acme_email: $acme_email
    }' > /var/lib/shipway/bootstrap.json

  chown deployer:deployer /var/lib/shipway/bootstrap.json
  chmod 0600 /var/lib/shipway/bootstrap.json
}

# ---------------------------------------------------------------------------
# 11. Fetch/build Shipway itself, install its unit
# ---------------------------------------------------------------------------

sync_shipway_source() {
  if [[ -f "${REPO_ROOT}/package.json" && -d "${REPO_ROOT}/server" && -d "${REPO_ROOT}/setup" ]]; then
    log "installing from local checkout at ${REPO_ROOT}"
    mkdir -p "$SHIPWAY_DIR"
    # `/data` (root-level, anchored — a dev-mode `SHIPWAY_DEV=1` run from the repo root writes its
    # SQLite db/secret keys there) and `*.log` (unanchored — matches at any depth, e.g.
    # `server/data/logs/**/*.log` or a stray debug log anywhere in the tree) are excluded so a
    # developer's local checkout never leaks a dev database or its secrets onto the server. Both are
    # already .gitignore'd (so a real `git clone` never has them), but this is the local-checkout
    # branch specifically *for when it isn't* a clean clone — see the header comment.
    rsync -a --delete \
      --exclude '.git' \
      --exclude 'node_modules' \
      --exclude '*/node_modules' \
      --exclude 'server/dist' \
      --exclude 'server/data' \
      --exclude 'web/dist' \
      --exclude '/data' \
      --exclude '*.log' \
      "${REPO_ROOT}/" "${SHIPWAY_DIR}/"
  elif [[ -n "${SHIPWAY_REPO_URL:-}" ]]; then
    log "cloning ${SHIPWAY_REPO_URL} into ${SHIPWAY_DIR}"
    if [[ -d "${SHIPWAY_DIR}/.git" ]]; then
      git -C "$SHIPWAY_DIR" fetch --all
      git -C "$SHIPWAY_DIR" reset --hard '@{upstream}'
    else
      rm -rf "$SHIPWAY_DIR"
      git clone "$SHIPWAY_REPO_URL" "$SHIPWAY_DIR"
    fi
  else
    die "not running from a Shipway checkout and SHIPWAY_REPO_URL is not set"
  fi

  chown -R deployer:deployer "$SHIPWAY_DIR"
}

build_shipway() {
  log "npm ci && npm run build (as deployer)"
  sudo -u deployer bash -lc "export PATH=/opt/node/22/bin:\$PATH && cd ${SHIPWAY_DIR} && npm ci && npm run build"
}

install_shipway_unit() {
  log "installing shipway.service"
  install -m 0644 -o root -g root "${SCRIPT_DIR}/shipway.service" /etc/systemd/system/shipway.service
  systemctl daemon-reload
  systemctl enable shipway
  systemctl restart shipway
}

# ---------------------------------------------------------------------------
# 12. nginx vhosts for the dashboard + mailpit
# ---------------------------------------------------------------------------

render_vhost() {
  local template="$1" dest_name="$2"
  # The template's placeholder is the literal text `${BASE_DOMAIN}`; the
  # `\$` below escapes it so bash doesn't expand it before sed ever sees it.
  sed "s|\${BASE_DOMAIN}|${BASE_DOMAIN}|g" "$template" > "/etc/nginx/sites-available/${dest_name}"
  ln -sf "/etc/nginx/sites-available/${dest_name}" "/etc/nginx/sites-enabled/${dest_name}"
}

install_vhosts() {
  log "rendering dashboard + mailpit nginx vhosts"
  render_vhost "${SCRIPT_DIR}/templates/nginx-dashboard.conf" "shipway-dashboard.conf"
  render_vhost "${SCRIPT_DIR}/templates/nginx-mailpit.conf" "shipway-mailpit.conf"

  nginx -t
  systemctl reload nginx
}

# ---------------------------------------------------------------------------
# 13. Cloudflare DNS records for ship.<domain> and mail.<domain>
# ---------------------------------------------------------------------------
# cf_api and ZONE_ID come from verify_cloudflare_access (preflight, section
# 7 above) — resolved once, reused here instead of looking the zone up again.

create_a_record_if_missing() {
  local zone_id="$1" name="$2"
  local response existing
  # The lookup and the jq parse are two separate steps (not a `cf_api | jq` pipe) so a curl-level
  # failure here dies with a clear message instead of being silently treated as "record doesn't
  # exist yet" — which would go on to attempt creating a possibly-duplicate record.
  response="$(cf_api "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records?type=A&name=${name}" 2>/dev/null)" \
    || die "Cloudflare API call failed while checking for an existing DNS record for ${name}. Check connectivity to api.cloudflare.com and that the token still has zone access, then re-run (already-created records are skipped, so this is safe to retry)."
  existing="$(printf '%s' "$response" | jq -r '.result[0].id // empty')"
  if [[ -n "$existing" ]]; then
    log "DNS A record for ${name} already exists, skipping"
    return
  fi

  log "creating DNS A record for ${name} -> ${SERVER_IP}"
  cf_api -X POST "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records" \
    --data "$(jq -n --arg name "$name" --arg content "$SERVER_IP" '{type: "A", name: $name, content: $content, ttl: 300, proxied: false}')" \
    > /dev/null
}

configure_dns() {
  create_a_record_if_missing "$ZONE_ID" "ship.${BASE_DOMAIN}"
  create_a_record_if_missing "$ZONE_ID" "mail.${BASE_DOMAIN}"
}

# ---------------------------------------------------------------------------
# Preflight orchestrator — the first thing `main` calls. Wires together the
# section-0 checks above with `read_prompts` (section 7) and
# `verify_cloudflare_access` (also section 7): every check here runs before
# this script changes anything on the system (beyond reading /etc/os-release
# and the network probes themselves). Order matters — cheap local checks
# first, then prompts (needed by the checks after them), then the network/
# DNS checks that need BASE_DOMAIN/SERVER_IP/CF_API_TOKEN. A Cloudflare
# failure here means zero packages have been touched yet.
# ---------------------------------------------------------------------------

preflight() {
  log "running preflight checks"

  check_ubuntu
  check_disk_space
  check_ports
  check_outbound_connectivity

  read_prompts

  verify_cloudflare_access
  check_dns_resolution

  log "preflight checks passed"
}

# ---------------------------------------------------------------------------
# 14. Postflight — verifies the install actually came up before declaring
#     success, instead of trusting that every prior step not exiting
#     nonzero means Shipway is actually reachable.
# ---------------------------------------------------------------------------

readonly POSTFLIGHT_HEALTH_RETRIES=12
readonly POSTFLIGHT_HEALTH_DELAY_S=5

postflight() {
  log "running postflight checks"

  local unit status core_ok=1
  for unit in shipway nginx mysql postgresql redis-server mailpit; do
    status="$(systemctl is-active "$unit" 2>/dev/null || true)"
    log "  ${unit}: ${status:-unknown}"
    if [[ "$unit" == "shipway" || "$unit" == "nginx" ]] && [[ "$status" != "active" ]]; then
      core_ok=0
    fi
  done

  local health_url="https://ship.${BASE_DOMAIN}/api/health"
  local attempt health_ok=0
  for ((attempt = 1; attempt <= POSTFLIGHT_HEALTH_RETRIES; attempt++)); do
    if curl -fsS --max-time 5 "$health_url" > /dev/null 2>&1; then
      health_ok=1
      break
    fi
    sleep "$POSTFLIGHT_HEALTH_DELAY_S"
  done

  echo
  echo "==============================================================="
  echo " Shipway is installed"
  echo "==============================================================="
  echo " Dashboard:      https://ship.${BASE_DOMAIN}"
  if [[ "$health_ok" == "1" ]]; then
    echo " Health check:   OK (${health_url})"
  else
    echo " Health check:   still failing after $((POSTFLIGHT_HEALTH_RETRIES * POSTFLIGHT_HEALTH_DELAY_S))s (${health_url})"
    echo "                 Often just DNS propagation. Check: sudo systemctl status shipway nginx"
  fi
  echo " Next step:      open the dashboard URL and complete the first-run setup wizard"
  echo "                 (admin account, server settings, Cloudflare, GitHub App)."
  echo " Shipway data:   /var/lib/shipway (database, secret.key)"
  echo " Deployed apps:  /var/deploy/apps/<slug>"
  echo " Deploy logs:    /var/deploy/logs/<slug>/<deployment-id>.log"
  echo " Mailpit web UI: https://mail.${BASE_DOMAIN}  (user: intcore, password: ${MAILPIT_WEB_PASSWORD})"
  echo " MySQL console:  https://ship.${BASE_DOMAIN}/db/phpmyadmin/"
  echo "                 phpMyAdmin ${PMA_VERSION} on PHP ${PMA_PHP_VERSION}. No login of its own:"
  echo "                 nginx only lets a logged-in Shipway user through, then you supply a"
  echo "                 database account (Databases > Credentials reveals one)."
  echo " PG console:     https://ship.${BASE_DOMAIN}/db/pgadmin/"
  echo "                 pgAdmin ${PGADMIN_VERSION} (pgadmin.service). Same Shipway-session gate,"
  echo "                 then pgAdmin's own login:"
  echo "                 ${PGADMIN_ADMIN_EMAIL} / ${PGADMIN_ADMIN_PASSWORD}"
  echo "==============================================================="

  if [[ "$core_ok" != "1" ]]; then
    die "shipway and/or nginx are not active — see the systemctl status above. Check 'sudo journalctl -u shipway -n 100' and 'sudo journalctl -u nginx -n 100', fix the problem, then re-run install.sh (it is safe to re-run)."
  fi
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
  check_root
  preflight
  export DEBIAN_FRONTEND=noninteractive

  touch "$SECRETS_FILE"
  chmod 0600 "$SECRETS_FILE"

  install_base_packages
  install_php
  install_php_bin_shims
  install_composer

  install_databases
  configure_redis

  install_all_node_versions

  install_mailpit_binary
  install_mailpit_unit
  configure_mailpit_auth

  install_phpmyadmin
  install_pgadmin

  install_certbot

  create_deployer_user
  install_sysops_helper

  issue_certificate

  provision_mysql_admin
  provision_postgres_admin
  write_bootstrap_file

  sync_shipway_source
  build_shipway
  install_shipway_unit

  install_vhosts
  configure_dns

  postflight

  log "done. Shipway is live at https://ship.${BASE_DOMAIN} — open it to run the first-run setup wizard."
}

main "$@"
