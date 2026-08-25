# Deploying Shipway

This is the one document to follow to get Shipway running on a server, end to end: what to prepare, the exact commands, the first-run wizard, updating, backups, and troubleshooting. If you only read one file before running the installer, read this one.

## What Shipway needs

**A dedicated Ubuntu 24.04 LTS server**, root access, nothing else important running on it. The installer is idempotent (safe to re-run), but it is not meant to share a box with an unrelated nginx/PHP/MySQL setup: it installs and manages system-wide nginx vhosts, php-fpm pools, and a sudoers policy.

**Sizing.** There's no hard minimum enforced beyond a disk-space safety check (the installer refuses to start with less than 2GB free on `/`, since PHP 8.1 through 8.4, MySQL, PostgreSQL, three Node runtimes, and the Shipway build alone can exceed that). For actually running a handful of client projects day to day, a practical baseline is:

| Resource | Minimum to consider |
|---|---|
| vCPU | 2 |
| RAM | 4 GB |
| Disk | 40 GB SSD |

Scale disk and RAM up with the number and size of projects you deploy; each release is a full copy of the built app, and the last 5 releases per project are kept for instant rollback.

**A domain managed at Cloudflare.** Shipway issues one wildcard TLS certificate for `*.<base-domain>` via Let's Encrypt DNS-01, and manages DNS records for every project subdomain through the Cloudflare API. It does not support other DNS providers.

**A Cloudflare API token** with exactly these permissions, scoped to that one zone:

- **Zone / Zone / Read**
- **Zone / DNS / Edit**

Cloudflare's dashboard "Edit zone DNS" template (My Profile > API Tokens > Create Token) already bundles both, so pick that template, restrict "Zone Resources" to the one zone, and you're done. You'll use this same token twice: once when the installer runs (to create its own two DNS records and issue the certificate), and again in the first-run wizard (stored this time, so Shipway can manage every new project's subdomain record going forward).

**DNS records to create before you run the installer.** Add these two `A` records at Cloudflare first, both set to **DNS only** (grey cloud, not proxied, matching how Shipway creates its own records):

| Type | Name | Value | Proxy status |
|---|---|---|---|
| A | `*` (i.e. `*.<base-domain>`) | your server's public IP | DNS only |
| A | `@` (i.e. `<base-domain>` itself) | your server's public IP | DNS only |

Every future project's `<slug>.<base-domain>` actually gets its own explicit `A` record — Shipway creates it through the Cloudflare API the moment you create the project (see "Creating the first project" below), and provisioning fails outright if that call fails, so a project's subdomain is never silently relying on the wildcard to resolve. What the wildcard record here is actually for: the installer's own preflight (`check_dns_resolution`) probes a throwaway `*.<base-domain>` hostname to confirm wildcard DNS is wired up correctly at Cloudflare before it touches the system, and warns (rather than fails) if it isn't yet. The apex record isn't served by anything Shipway installs today, but the installer checks that both resolve correctly before touching the system and will ask you to confirm if they don't, so create both to avoid that prompt. Cloudflare's own DNS propagates in seconds to a couple of minutes; give it a minute after creating these before running the installer.

Shipway creates two more records itself during install, under the same zone: `deploy.<base-domain>` (the dashboard) and `mail.<base-domain>` (the Mailpit web UI). You don't need to create those.

**An email address** for Let's Encrypt expiry/renewal notices (the ACME account email). Certbot's own timer renews the certificate automatically; this address only matters if renewal ever fails.

**The server's public IP address.** Same one you used in the DNS records above.

## Cloning and running the installer

SSH into the fresh server as a user who can `sudo`, then:

```bash
git clone <this repo's URL> shipway
cd shipway
sudo ./setup/install.sh
```

That's the entire command sequence. Nothing else needs to be installed first; the script brings in everything itself (nginx, PHP, MySQL, PostgreSQL, Redis, Node, Mailpit, certbot).

### What it asks

Four questions, in this order:

1. **Base domain** (e.g. `intcore.dev`). Just the domain, no `https://`, no trailing dot, no subdomain. This must be the exact zone name in Cloudflare, not a subdomain of it.
2. **Server public IP**. The same IP you pointed the DNS records at.
3. **Cloudflare API token**. The one scoped to Zone:Read + DNS:Edit from above. Input is hidden while you type it.
4. **ACME/Let's Encrypt contact email**. A real, monitored inbox.

Before it asks anything, the installer runs a preflight check: confirms it's root, warns (but continues) if the OS isn't exactly Ubuntu 24.04, checks free disk space, checks ports 80/443 are free, and checks outbound DNS/HTTPS reachability. Right after you answer the four questions, it verifies the Cloudflare token can see the zone, and checks whether the DNS records above have actually propagated, if they haven't, it prints what it found and asks `Continue anyway? [y/N]`. Everything up to and including the Cloudflare check happens before a single package is installed, so a wrong token or a typo'd domain fails immediately instead of after twenty minutes of setup.

### How long it takes, and what it installs

Typically **10 to 20 minutes**, mostly apt package installs and the Shipway build; it depends on the server's network speed and specs. In order, it:

1. Installs nginx, PHP 8.1 through 8.4 (via the `ondrej/php` PPA, with the extensions Laravel apps typically need) plus Composer.
2. Installs MySQL, PostgreSQL, and Redis, and sets a random Redis password.
3. Installs Node 18, 20, and 22 side by side under `/opt/node/<version>`, verifying each download's checksum against the official `SHASUMS256.txt` first.
4. Installs Mailpit (the shared catch-all SMTP inbox) as its own systemd service, and protects its web UI with HTTP basic auth (random password, printed in the final summary).
5. Installs certbot and requests one wildcard certificate for `*.<base-domain>` and `<base-domain>` via Cloudflare DNS-01. This does not need ports 80/443 open to the world, since it's a DNS challenge, not an HTTP one.
6. Creates the `deployer` system user, its directories, the `shipway-sysops` root helper, and a sudoers policy that lets `deployer` run exactly the handful of commands Shipway needs (reload nginx/php-fpm, manage its own `shipway-*` systemd units) and nothing else. Also installs and enables the `cron` service, since project cron schedules (Projects > a project > Cron) are written with the bare `crontab` command.
7. Creates a `shipway_admin` MySQL user and Postgres role with random passwords.
8. Builds Shipway itself into `/opt/shipway` and starts it as `shipway.service`.
9. Renders the nginx vhosts for the dashboard and Mailpit's web UI, and reloads nginx.
10. Creates the `deploy.` and `mail.` DNS `A` records at Cloudflare.
11. Runs a postflight check: confirms shipway, nginx, mysql, postgresql, redis-server, and mailpit are all active, then polls `https://deploy.<base-domain>/api/health` (up to a minute) before printing a final summary with the dashboard URL, the Mailpit credentials, and where everything lives on disk.

Re-running `install.sh` is safe: every step checks whether its work is already done before repeating it, generated passwords are cached in `/root/.shipway-install-secrets` so a re-run never rotates a credential something already depends on, and DNS records are looked up before being created so nothing gets duplicated. The one case that needs a deliberate decision instead of a silent one: if `/root/.shipway-install-secrets` itself is lost on a server that's already live, the installer refuses to guess — see "Lost `/root/.shipway-install-secrets` on an already-live server" under Troubleshooting.

## First-run setup wizard

Open `https://deploy.<base-domain>`. Shipway walks you through four steps:

**1. Admin account.** Name, email, password. This becomes the account owner. There's no separate registration page after this; the wizard only runs once, before any user exists.

**2. Server settings.** `base_domain`, `server_ip`, and the ACME email are already filled in, the installer wrote them into a one-time `bootstrap.json` file that Shipway imports on its first boot and then deletes. Confirm or adjust them here.

**3. Cloudflare.** Paste the same API token and this zone's ID (Cloudflare dashboard, right sidebar of the zone's overview page). The installer only used the token transiently to create its own two records and the certificate; Shipway needs it again, stored this time, to manage every new project's subdomain going forward. This step tests the connection live before letting you continue.

**4. GitHub App.** Click through GitHub's App Manifest flow, a button here redirects to GitHub with a pre-filled manifest (`contents:read` + `metadata:read` permissions, the `push` webhook event, webhook URL already pointed at `https://deploy.<base-domain>/api/webhooks/github`). GitHub redirects back with a code Shipway exchanges automatically for the app ID, private key, and webhook secret. A manual paste-the-fields fallback is on the same page if you'd rather create the App yourself. This step can be skipped and configured later from Settings if you'd rather deploy your first project from a plain Git URL instead of GitHub.

Once the App is created, go to GitHub and **install it** on your org (or just the specific repos you want Shipway to deploy) from the App's own "Install App" page. Come back to Shipway's GitHub settings and resolve the installation; from then on, **Projects > New** lists that installation's repositories.

## Creating the first project

**Projects > New.** Pick a repository (from the GitHub App's installation) or paste a Git URL for a repo outside GitHub, a branch, and a runtime (PHP, Node, Next.js, or static). Shipway shows the exact `A` record it's about to create for the project's subdomain, checks the Cloudflare connection live, and confirms the result before landing you on the first deploy. From there, pushing to that branch triggers a deploy automatically (if using the GitHub App); a Git-URL project deploys on demand from the dashboard.

## Updating

```bash
sudo /opt/shipway/setup/update.sh
```

Pulls the latest commit as `deployer`, rebuilds (`npm ci && npm run build`), and restarts `shipway.service`. Database migrations run automatically the next time the process starts, there is no separate migrate step.

## Where everything lives

| Path | What |
|---|---|
| `/opt/shipway` | The Shipway tool itself (this repo, built) |
| `/var/lib/shipway/shipway.db` | Shipway's own SQLite database |
| `/var/lib/shipway/secret.key` | Encryption key for env vars/secrets at rest (mode 0600) |
| `/var/lib/shipway/session.key` | Session cookie signing/encryption key |
| `/var/deploy/apps/<slug>/` | One project's releases: `repo/` (bare git mirror), `releases/<timestamp>/`, `shared/` (persists across releases, including `.env`), `current` (symlink to the live release) |
| `/var/deploy/logs/<slug>/<deployment-id>.log` | Per-deploy build/activate logs |
| `/opt/node/<18\|20\|22>/bin/node` | Node runtimes, one directory per major version |
| `/opt/php/<8.1\|8.2\|8.3\|8.4>/bin/php` | Version-pinned PHP shims used by project build/deploy scripts |
| `/etc/nginx/sites-available/shipway-*.conf`, `sites-enabled/` | Project (and the dashboard/Mailpit) vhosts |
| `/etc/systemd/system/shipway-*.service` | Per-project app/worker units |
| `/etc/systemd/system/shipway.service` | Shipway itself |
| `/usr/local/bin/shipway-sysops` | The whitelisted root helper the `deployer` user's sudo rules allow |
| `/etc/letsencrypt/live/<base-domain>/` | The wildcard certificate |
| `/root/.shipway-install-secrets` | Cached install-time secrets (MySQL/Postgres/Redis/Mailpit passwords), root-only |

## Backing up

Four things matter. Back them all up together, they reference each other (encrypted values in the database are only readable with the matching key):

1. **`/var/lib/shipway/shipway.db`**, the SQLite database: users, projects, deployment history, audit log, encrypted env vars and SMTP config.
2. **`/var/lib/shipway/secret.key`**, the encryption key for everything encrypted in that database. Without it, the encrypted env vars and SMTP passwords stored in the database are unrecoverable.
3. **`/var/lib/shipway/session.key`**, the session cookie signing/encryption key. Restoring `shipway.db` without the matching `session.key` doesn't lose any data, but it silently invalidates every existing login session (everyone gets signed out).
4. **`/var/deploy/apps/<slug>/shared/`** for each project, this is what persists across releases: `.env` files, uploaded files, anything a project's `sharedPaths` config points at.

A simple approach that covers all four:

```bash
sudo tar -czf shipway-backup-$(date +%Y%m%d).tar.gz \
  /var/lib/shipway/shipway.db \
  /var/lib/shipway/secret.key \
  /var/lib/shipway/session.key \
  /var/deploy/apps/*/shared
```

Copy that archive off the server. `shipway.db` is a live SQLite database under WAL mode; stopping `shipway.service` first (`sudo systemctl stop shipway`) gives you a guaranteed-consistent snapshot, though a live copy is normally fine too since better-sqlite3's WAL checkpoints are frequent.

There is no built-in backup scheduler. Cron the command above, or point your existing backup tooling at those same paths.

**Also worth backing up separately: `/root/.shipway-install-secrets`.** It isn't needed to restore Shipway itself — the same MySQL/Postgres/Redis/Mailpit credentials it caches also end up in Shipway's own settings once `bootstrap.json` is imported on first boot — but losing it on a server that's already live changes what a future `install.sh` re-run can safely do: with the file missing, the installer can no longer tell whether `shipway_admin`'s live MySQL/Postgres password matches what Shipway has stored, so it refuses to guess (see "Lost `/root/.shipway-install-secrets` on an already-live server" below) instead of silently rotating into a broken state. Keep a copy and that scenario never comes up. It's plaintext root-only (mode 0600) credentials, so store the copy at least as carefully as you'd store the rest of this backup (encrypted at rest off-server).

## Troubleshooting

**A project's site is down, or a deploy failed to activate.**
Check the deploy's log first, either in the dashboard (Project > Deployments > that deploy) or directly at `/var/deploy/logs/<slug>/<deployment-id>.log`. A failed deploy never leaves a working site broken: failures before activation are discarded, failures after activation can be rolled back from the same screen.

**nginx won't reload, or a new project's vhost didn't take effect.**
```bash
sudo nginx -t
```
This shows the exact config error. Shipway runs this same check itself before ever reloading nginx, so a broken vhost is rejected (and rolled back) rather than taking the whole server offline.

**Shipway itself won't start, or the dashboard is unreachable.**
```bash
sudo systemctl status shipway
sudo journalctl -u shipway -n 200
```
Also check `sudo systemctl status nginx` and, from the server itself, `curl -v http://127.0.0.1:8090/api/health` (Shipway only listens on localhost; nginx terminates TLS and proxies to it).

**A worker keeps restarting, or its output isn't what you expect.**
Worker logs go through the systemd journal like any other unit: `sudo journalctl -u shipway-worker-<slug>-<name>@1 -n 200`, or use the log tail in the dashboard's Workers tab.

**Certificate renewal.**
Certbot's systemd timer handles renewal on its own; `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` reloads nginx automatically after a successful renewal. To test the renewal path without waiting for the real expiry window:
```bash
sudo certbot renew --dry-run
```

**Database credentials.**
Reveal a project's database credentials from the dashboard (Databases > that database > reveal). The `shipway_admin` MySQL/Postgres credentials the installer created live only in Shipway's settings after the one-time bootstrap import; they are not written anywhere else on disk (the file the installer wrote them to, `bootstrap.json`, is deleted right after Shipway imports it on first boot) — except the install-time cache at `/root/.shipway-install-secrets`, which `install.sh` itself reads on every re-run (see below).

**Lost `/root/.shipway-install-secrets` on an already-live server.**
This file is a plaintext cache of the passwords `install.sh` generated (MySQL/Postgres/Redis/Mailpit admin credentials). If it's lost or replaced on a server that already has a working `shipway_admin` MySQL user / Postgres role, do **not** just re-run `install.sh` and hope: `provision_mysql_admin`/`provision_postgres_admin` in `setup/install.sh` detect exactly this — the account/role already exists, but the secrets file has no password cached for it — and refuse to guess by default, `die()`-ing with the two options below instead. The reason this needs a deliberate choice rather than the installer just doing the obvious thing: minting a brand-new random password is exactly right for a fresh install (nothing depends on the old one yet), but wrong here, because Shipway is already relying on the specific password it has stored in its own settings to connect as `shipway_admin` — pushing a different one live with `ALTER USER`/`ALTER ROLE` (which the installer always did unconditionally, on every re-run, before this fix) would silently break that connection, since Shipway's stored `mysql_admin_url`/`postgres_admin_url` settings are only ever filled in when unset, never overwritten, by default.

*Option A — recover the real password without rotating anything (preferred).* Shipway already has the live, working password in its own settings table (plain JSON text, not encrypted — unlike env vars/SMTP passwords). Read it directly with the `better-sqlite3` dependency already vendored under `/opt/shipway/server/node_modules` (no new packages needed):

```bash
sudo /opt/node/22/bin/node -e "
const Database = require('/opt/shipway/server/node_modules/better-sqlite3');
const db = new Database('/var/lib/shipway/shipway.db', { readonly: true });
for (const key of ['mysql_admin_url', 'postgres_admin_url']) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  console.log(key + ' = ' + (row ? JSON.parse(row.value) : '(not set)'));
}
"
```

Each printed URL is `mysql://shipway_admin:<password>@127.0.0.1:3306` / `postgres://shipway_admin:<password>@127.0.0.1:5432/postgres` — copy the password out of it and append matching lines to the secrets file (creating it if needed):

```bash
echo "MYSQL_ADMIN_PASSWORD=<password from mysql_admin_url>" | sudo tee -a /root/.shipway-install-secrets
echo "POSTGRES_ADMIN_PASSWORD=<password from postgres_admin_url>" | sudo tee -a /root/.shipway-install-secrets
sudo chmod 0600 /root/.shipway-install-secrets
sudo ./setup/install.sh
```

That re-run is now a normal, safe no-op for these two accounts (the ALTER USER/ALTER ROLE just reasserts the same password), and every other step behaves exactly as any other re-run.

*Option B — deliberately rotate the password instead.* If you'd rather not (or can't) recover the old one, re-run with `SHIPWAY_ROTATE_DB_ADMIN=1`:

```bash
sudo SHIPWAY_ROTATE_DB_ADMIN=1 ./setup/install.sh
```

This mints a fresh password, pushes it live with `ALTER USER`/`ALTER ROLE` as before, **and** writes `bootstrap.json` with `force_admin_urls: true`, which tells Shipway (on the restart this same run triggers) to overwrite its stored `mysql_admin_url`/`postgres_admin_url` settings to match — narrowly, only those two keys, nothing else you've configured in Settings is touched. Anything holding a connection open with the old password will need to reconnect. Only ever pass this flag deliberately; it's not needed for a normal install or a normal re-run.

**Resetting the admin password.**
There is no supported way to do this from within Shipway today: there's no "forgot password" flow, and the setup wizard's admin-creation step only runs once, before any user exists, so it can't be used to replace a lost password later. If you're still logged in as an owner or admin somewhere, use that session to invite a new admin (Settings > Team) rather than trying to recover the old password.

If you're completely locked out (no active session, no other admin), the only honest option is direct database surgery. Ubuntu 24.04 minimal images and this installer don't ship the `sqlite3` CLI, so do this instead with the `better-sqlite3` and `argon2` packages already vendored under `/opt/shipway/server/node_modules` (the exact ones Shipway itself uses to store and verify passwords — `argon2.hash()` defaults to argon2id, matching `server/src/lib/passwords.ts`, and the `users` table's password column is `password_hash`):

```bash
sudo systemctl stop shipway
sudo cp /var/lib/shipway/shipway.db /var/lib/shipway/shipway.db.bak-$(date +%Y%m%d)   # back it up first

sudo /opt/node/22/bin/node -e "
const argon2 = require('/opt/shipway/server/node_modules/argon2');
const Database = require('/opt/shipway/server/node_modules/better-sqlite3');
(async () => {
  const email = 'admin@example.com';        // <-- the locked-out user's email
  const newPassword = 'choose-a-strong-password'; // <-- the new password
  const hash = await argon2.hash(newPassword);
  const db = new Database('/var/lib/shipway/shipway.db');
  const info = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, email);
  if (info.changes !== 1) {
    throw new Error('expected to update exactly 1 row, updated ' + info.changes + ' — check the email and try again');
  }
  console.log('password updated for', email);
})();
"

sudo systemctl start shipway
```

This is not a supported, documented (beyond this), or tested-in-CI procedure — get the `UPDATE` wrong and you can corrupt the database, which is why the command above refuses to proceed unless exactly one row matched. Treat it as a last resort rather than a normal recovery path; re-run the invite flow (Settings > Team, from another admin session) instead whenever that's an option.

## Non-interactive / unattended install

Every prompt `install.sh` asks can be answered via environment variables instead, for scripted or repeatable installs:

| Variable | Replaces | Required? |
|---|---|---|
| `SHIPWAY_BASE_DOMAIN` | "Base domain" prompt | Yes, if unattended |
| `SHIPWAY_SERVER_IP` | "Server public IP" prompt | Yes, if unattended |
| `SHIPWAY_CF_API_TOKEN` | "Cloudflare API token" prompt | Yes, if unattended |
| `SHIPWAY_ACME_EMAIL` | "ACME/Let's Encrypt contact email" prompt | Yes, if unattended |
| `SHIPWAY_NONINTERACTIVE=1` | The "DNS doesn't resolve yet, continue anyway? [y/N]" confirmation | No, only needed if DNS might not have propagated yet |
| `SHIPWAY_REPO_URL` | Nothing to run from | Only if not running from inside a checkout (see below) |
| `SHIPWAY_ROTATE_DB_ADMIN=1` | Nothing — it's not a normal-install variable | No. Only relevant when recovering from a lost `/root/.shipway-install-secrets` on an already-live server; see "Lost `/root/.shipway-install-secrets` on an already-live server" under Troubleshooting. Never set it for a routine unattended install. |

A fully unattended run, from inside a checkout:

```bash
sudo SHIPWAY_BASE_DOMAIN=intcore.dev \
  SHIPWAY_SERVER_IP=203.0.113.10 \
  SHIPWAY_CF_API_TOKEN=your-token-here \
  SHIPWAY_ACME_EMAIL=ops@intcore.dev \
  SHIPWAY_NONINTERACTIVE=1 \
  ./setup/install.sh
```

If you're not running the script from inside a Shipway checkout (for example, a provisioning tool that only copies `setup/install.sh` itself onto the box), set `SHIPWAY_REPO_URL` to a git URL and the installer clones it instead:

```bash
sudo SHIPWAY_REPO_URL=https://github.com/your-org/shipway.git \
  SHIPWAY_BASE_DOMAIN=intcore.dev \
  SHIPWAY_SERVER_IP=203.0.113.10 \
  SHIPWAY_CF_API_TOKEN=your-token-here \
  SHIPWAY_ACME_EMAIL=ops@intcore.dev \
  SHIPWAY_NONINTERACTIVE=1 \
  ./install.sh
```

Every other preflight check (root, disk space, ports 80/443, outbound connectivity, Cloudflare token/zone validity) still runs and still fails loudly, with no env var to bypass them: they check things that are either objectively true or false about the box and the credentials, not judgment calls for a human to override.
