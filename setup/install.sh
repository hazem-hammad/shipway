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
# `check_dns_resolution`) and proceed unattended. SHIPWAY_ROTATE_DB_ADMIN=1 is a separate, rare,
# deliberate opt-in — see `provision_mysql_admin`/`provision_postgres_admin` below and
# DEPLOYMENT.md's "Lost /root/.shipway-install-secrets on an already-live server" section — not
# needed for a normal install.
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

# True (exit 0) if $SECRETS_FILE already has a non-empty value cached for $1, without generating
# one — unlike get_or_create_secret, this never mints or writes anything. Used by
# provision_mysql_admin/provision_postgres_admin to detect "the live admin account already exists,
# but its password isn't in the cache" BEFORE minting a new one, so that dangerous case can be
# handled deliberately instead of get_or_create_secret silently generating a value that doesn't
# match what's already live.
secret_is_set() {
  local name="$1"
  local existing
  existing="$(grep -m1 "^${name}=" "$SECRETS_FILE" 2>/dev/null | cut -d= -f2- || true)"
  [[ -n "$existing" ]]
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
    nginx git curl acl unzip \
    software-properties-common rsync jq ca-certificates cron

  # Ubuntu's `cron` package normally enables and starts itself on install via its postinst script,
  # but `enable --now` is idempotent and cheap — asserting it explicitly means user crontabs (see
  # server/src/sysops/real.ts's readCrontab/writeCrontab, which shell out to bare `crontab`) are
  # guaranteed to actually fire rather than silently sitting unscheduled on a minimal image where
  # that postinst behavior might differ.
  systemctl enable --now cron
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

  install -d -m 0750 -o deployer -g deployer /var/deploy/apps
  install -d -m 0750 -o deployer -g deployer /var/deploy/logs
  install -d -m 0750 -o deployer -g deployer /var/lib/shipway

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

# Set to 1 by provision_mysql_admin/provision_postgres_admin when SHIPWAY_ROTATE_DB_ADMIN=1
# deliberately rotated an already-live admin credential (secrets file was lost). write_bootstrap_file
# reads these to set bootstrap.json's `force_admin_urls` flag, so importBootstrap.ts overwrites
# Shipway's already-stored mysql_admin_url/postgres_admin_url settings to match the new password
# instead of leaving them silently pointed at the now-wrong old one (Finding 1).
MYSQL_ADMIN_ROTATED=0
POSTGRES_ADMIN_ROTATED=0

# Guards the "secrets file lost on an already-live server" hazard described in the file header and
# DEPLOYMENT.md's "Lost /root/.shipway-install-secrets on an already-live server" section: if the
# admin account/role already exists but its password isn't in $SECRETS_FILE, minting and pushing a
# new one live (the old, unconditional behavior) would silently break Shipway's already-stored
# mysql_admin_url/postgres_admin_url, since importBootstrap only fills unset settings keys. Refuses
# by default (die() with recovery instructions); proceeds only if the operator explicitly opted in
# with SHIPWAY_ROTATE_DB_ADMIN=1, in which case the caller is told (via the rotated_var nameref-by-
# convention below) to also force-update Shipway's stored setting once the install finishes.
#
# $1: human label ("MySQL 'shipway_admin' user" / "Postgres 'shipway_admin' role")
# $2: 1 if the account/role already exists, 0 otherwise
# $3: secret name in $SECRETS_FILE (MYSQL_ADMIN_PASSWORD / POSTGRES_ADMIN_PASSWORD)
# $4: name of the *_ROTATED variable to set to 1 on a deliberate rotation
guard_admin_secret_loss() {
  local label="$1" account_exists="$2" secret_name="$3" rotated_var="$4"

  if [[ "$account_exists" != "1" ]] || secret_is_set "$secret_name"; then
    return
  fi

  if [[ "${SHIPWAY_ROTATE_DB_ADMIN:-}" == "1" ]]; then
    log "WARNING: ${label} already exists, but ${SECRETS_FILE} has no ${secret_name} entry. SHIPWAY_ROTATE_DB_ADMIN=1 is set, so its password is being rotated now, and Shipway's stored setting will be force-updated to match once this install finishes (bootstrap.json's force_admin_urls) so database provisioning keeps working. Anything holding the OLD password open (e.g. a long-lived connection) will need to reconnect."
    printf -v "$rotated_var" '%s' 1
    return
  fi

  die "${label} already exists, but ${SECRETS_FILE} has no ${secret_name} entry — the secrets file was likely lost or replaced on an already-provisioned server. Re-running as-is would mint a brand-new random password and push it live, but Shipway's already-stored setting for it would NOT be updated to match (importBootstrap only fills unset keys), silently breaking database provisioning (see DEPLOYMENT.md's 'Lost /root/.shipway-install-secrets on an already-live server' section for the full explanation and a command to read the real live password back out of Shipway's own settings, without rotating anything). To instead deliberately rotate the password now (and have this installer update Shipway's stored setting to match automatically), re-run with SHIPWAY_ROTATE_DB_ADMIN=1."
}

provision_mysql_admin() {
  local admin_exists
  admin_exists="$(mysql -u root -N -B -e "SELECT COUNT(*) FROM mysql.user WHERE user='shipway_admin' AND host='localhost'" 2>/dev/null || echo 0)"

  guard_admin_secret_loss "MySQL 'shipway_admin' user" "$admin_exists" MYSQL_ADMIN_PASSWORD MYSQL_ADMIN_ROTATED

  MYSQL_ADMIN_PASSWORD="$(get_or_create_secret MYSQL_ADMIN_PASSWORD)"
  log "provisioning MySQL shipway_admin user"
  # Granted at both hosts — see the file header comment for why. The
  # trailing ALTER USERs are not redundant with CREATE USER IF NOT EXISTS:
  # if the account already existed, CREATE's IDENTIFIED BY clause is a
  # no-op, so without the ALTER the account's real password could drift
  # from whatever get_or_create_secret just returned. guard_admin_secret_loss
  # above ensures that value is either the account's real current password
  # (secret was cached) or a deliberate, operator-approved rotation
  # (SHIPWAY_ROTATE_DB_ADMIN=1) — never a silent mismatch.
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
  local exists
  exists="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='shipway_admin'")"

  # $exists is "1" or "" (psql -tAc prints nothing for a query with no matching row), and
  # guard_admin_secret_loss only checks it against "1", so it's passed through as-is.
  guard_admin_secret_loss "Postgres 'shipway_admin' role" "$exists" POSTGRES_ADMIN_PASSWORD POSTGRES_ADMIN_ROTATED

  POSTGRES_ADMIN_PASSWORD="$(get_or_create_secret POSTGRES_ADMIN_PASSWORD)"
  log "provisioning Postgres shipway_admin role"
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

  # See guard_admin_secret_loss/provision_mysql_admin/provision_postgres_admin: only true when
  # SHIPWAY_ROTATE_DB_ADMIN=1 deliberately rotated an already-live admin credential this run. Tells
  # server/src/lib/bootstrap.ts's importBootstrap to overwrite Shipway's already-stored
  # mysql_admin_url/postgres_admin_url settings (and ONLY those two) instead of skipping them as
  # already-set, so the rotated password actually becomes the one Shipway uses (Finding 1) — every
  # other bootstrap.json key keeps the normal fill-only-if-unset behavior either way.
  local force_admin_urls="false"
  if [[ "$MYSQL_ADMIN_ROTATED" == "1" || "$POSTGRES_ADMIN_ROTATED" == "1" ]]; then
    force_admin_urls="true"
    log "WARNING: bootstrap.json is being written with force_admin_urls=true — on next boot Shipway will overwrite its stored mysql_admin_url/postgres_admin_url settings with the values below, even though they're already set, because SHIPWAY_ROTATE_DB_ADMIN=1 rotated a live admin credential during this run."
  fi

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
    --argjson force_admin_urls "$force_admin_urls" \
    '{
      mysql_admin_url: $mysql_admin_url,
      postgres_admin_url: $postgres_admin_url,
      redis_info: { host: $redis_host, port: $redis_port, password: $redis_password },
      mailpit_info: { smtpHost: $mailpit_smtp_host, smtpPort: $mailpit_smtp_port, webUrl: $mailpit_web_url, username: $mailpit_username, webPassword: $mailpit_web_password },
      base_domain: $base_domain,
      server_ip: $server_ip,
      acme_email: $acme_email
    } + (if $force_admin_urls then {force_admin_urls: true} else {} end)' > /var/lib/shipway/bootstrap.json

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
  # Same two-step shape as the lookup above (curl-level failure dies clearly instead of being
  # misread as success), plus a `.success` check the lookup doesn't need: Cloudflare's API can
  # return HTTP 200 with `"success": false` and an `errors` array for a logically-failed request
  # (bad zone, invalid record, rate limit, ...) — matching how the server's own
  # CloudflareDnsClient.createARecord (server/src/services/cloudflare.ts) treats the same response.
  # Discarding this to /dev/null with no check, as before, would silently treat that as success.
  local create_response create_ok create_errors
  create_response="$(cf_api -X POST "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records" \
    --data "$(jq -n --arg name "$name" --arg content "$SERVER_IP" '{type: "A", name: $name, content: $content, ttl: 300, proxied: false}')" 2>/dev/null)" \
    || die "Cloudflare API call failed while creating the DNS A record for ${name}. Check connectivity to api.cloudflare.com and that the token still has zone access, then re-run (already-created records are skipped, so this is safe to retry)."
  create_ok="$(printf '%s' "$create_response" | jq -r '.success == true' 2>/dev/null || echo false)"
  if [[ "$create_ok" != "true" ]]; then
    create_errors="$(printf '%s' "$create_response" | jq -r '[.errors[]?.message] | join("; ")' 2>/dev/null || true)"
    die "Cloudflare rejected creating the DNS A record for ${name} -> ${SERVER_IP}: ${create_errors:-$create_response}"
  fi
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
