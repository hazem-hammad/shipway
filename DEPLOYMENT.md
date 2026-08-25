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

The wildcard is what makes every future project's `<slug>.<base-domain>` resolve without a manual DNS step per project. The apex record isn't served by anything Shipway installs today, but the installer checks that both resolve correctly before touching the system and will ask you to confirm if they don't, so create both to avoid that prompt. Cloudflare's own DNS propagates in seconds to a couple of minutes; give it a minute after creating these before running the installer.

Shipway creates two more records itself during install, under the same zone: `ship.<base-domain>` (the dashboard) and `mail.<base-domain>` (the Mailpit web UI). You don't need to create those.

For this install specifically: base domain is `intcore.dev`, so the dashboard comes up at `ship.intcore.dev`, matching the subdomain already reserved for it.

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
6. Creates the `deployer` system user, its directories, the `shipway-sysops` root helper, and a sudoers policy that lets `deployer` run exactly the handful of commands Shipway needs (reload nginx/php-fpm, manage its own `shipway-*` systemd units) and nothing else.
7. Creates a `shipway_admin` MySQL user and Postgres role with random passwords.
8. Builds Shipway itself into `/opt/shipway` and starts it as `shipway.service`.
9. Renders the nginx vhosts for the dashboard and Mailpit's web UI, and reloads nginx.
10. Creates the `ship.` and `mail.` DNS `A` records at Cloudflare.
11. Runs a postflight check: confirms shipway, nginx, mysql, postgresql, redis-server, and mailpit are all active, then polls `https://ship.<base-domain>/api/health` (up to a minute) before printing a final summary with the dashboard URL, the Mailpit credentials, and where everything lives on disk.

Re-running `install.sh` is safe: every step checks whether its work is already done before repeating it, generated passwords are cached in `/root/.shipway-install-secrets` so a re-run never rotates a credential something already depends on, and DNS records are looked up before being created so nothing gets duplicated.

## First-run setup wizard

Open `https://ship.<base-domain>`. Shipway walks you through four steps:

**1. Admin account.** Name, email, password. This becomes the account owner. There's no separate registration page after this; the wizard only runs once, before any user exists.

**2. Server settings.** `base_domain`, `server_ip`, and the ACME email are already filled in, the installer wrote them into a one-time `bootstrap.json` file that Shipway imports on its first boot and then deletes. Confirm or adjust them here.

**3. Cloudflare.** Paste the same API token and this zone's ID (Cloudflare dashboard, right sidebar of the zone's overview page). The installer only used the token transiently to create its own two records and the certificate; Shipway needs it again, stored this time, to manage every new project's subdomain going forward. This step tests the connection live before letting you continue.

**4. GitHub App.** Click through GitHub's App Manifest flow, a button here redirects to GitHub with a pre-filled manifest (`contents:read` + `metadata:read` permissions, the `push` webhook event, webhook URL already pointed at `https://ship.<base-domain>/api/webhooks/github`). GitHub redirects back with a code Shipway exchanges automatically for the app ID, private key, and webhook secret. A manual paste-the-fields fallback is on the same page if you'd rather create the App yourself. This step can be skipped and configured later from Settings if you'd rather deploy your first project from a plain Git URL instead of GitHub.

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

Three things matter. Back all three up together, they reference each other (encrypted values in the database are only readable with the matching key):

1. **`/var/lib/shipway/shipway.db`**, the SQLite database: users, projects, deployment history, audit log, encrypted env vars and SMTP config.
2. **`/var/lib/shipway/secret.key`**, the encryption key for everything encrypted in that database. Without it, the encrypted env vars and SMTP passwords stored in the database are unrecoverable.
3. **`/var/deploy/apps/<slug>/shared/`** for each project, this is what persists across releases: `.env` files, uploaded files, anything a project's `sharedPaths` config points at.

A simple approach that covers all of it:

```bash
sudo tar -czf shipway-backup-$(date +%Y%m%d).tar.gz \
  /var/lib/shipway/shipway.db \
  /var/lib/shipway/secret.key \
  /var/lib/shipway/session.key \
  /var/deploy/apps/*/shared
```

Copy that archive off the server. `shipway.db` is a live SQLite database under WAL mode; stopping `shipway.service` first (`sudo systemctl stop shipway`) gives you a guaranteed-consistent snapshot, though a live copy is normally fine too since better-sqlite3's WAL checkpoints are frequent.

There is no built-in backup scheduler. Cron the command above, or point your existing backup tooling at those same paths.

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
Reveal a project's database credentials from the dashboard (Databases > that database > reveal). The `shipway_admin` MySQL/Postgres credentials the installer created live only in Shipway's settings after the one-time bootstrap import; they are not written anywhere else on disk (the file the installer wrote them to, `bootstrap.json`, is deleted right after Shipway imports it on first boot).

**Resetting the admin password.**
There is no supported way to do this from within Shipway today: there's no "forgot password" flow, and the setup wizard's admin-creation step only runs once, before any user exists, so it can't be used to replace a lost password later. If you're still logged in as an owner or admin somewhere, use that session to invite a new admin (Settings > Team) rather than trying to recover the old password.

If you're completely locked out (no active session, no other admin), the only honest option is direct database surgery: stop Shipway, use `sqlite3` to inspect `/var/lib/shipway/shipway.db`'s `users` table, and write a new argon2id password hash into the matching row using the same library Shipway itself uses (`argon2`, already a dependency under `/opt/shipway/server/node_modules`). This is not a supported, documented, or tested procedure, get it wrong and you can corrupt the database; take a backup of `shipway.db` first, and treat this as a last resort rather than a normal recovery path.

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
