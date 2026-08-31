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
5. Installs the two database consoles, both served under paths on the dashboard host so the Shipway session is what gates them: phpMyAdmin at `ship.<base-domain>/db/phpmyadmin` (extracted from a tarball checksummed against a pinned sha256) and pgAdmin 4 at `ship.<base-domain>/db/pgadmin`, running as its own `pgadmin.service` behind gunicorn. Both are wired to sign you in as the Shipway user you already are — see **Managing a database's contents** below. pgAdmin also keeps a login of its own for direct use; its admin credentials are printed in the final summary.
6. Installs certbot and requests one wildcard certificate for `*.<base-domain>` and `<base-domain>` via Cloudflare DNS-01. This does not need ports 80/443 open to the world, since it's a DNS challenge, not an HTTP one.
7. Creates the `deployer` system user, its directories, the `shipway-sysops` root helper, and a sudoers policy that lets `deployer` run exactly the handful of commands Shipway needs (reload nginx/php-fpm, manage its own `shipway-*` systemd units) and nothing else.
8. Creates a `shipway_admin` MySQL user and Postgres role with random passwords.
9. Builds Shipway itself into `/opt/shipway` and starts it as `shipway.service`.
10. Renders the nginx vhosts for the dashboard and Mailpit's web UI, and reloads nginx.
11. Creates the `ship.` and `mail.` DNS `A` records at Cloudflare.
12. Runs a postflight check: confirms shipway, nginx, mysql, postgresql, redis-server, and mailpit are all active, then polls `https://ship.<base-domain>/api/health` (up to a minute) before printing a final summary with the dashboard URL, the Mailpit and database-console credentials, and where everything lives on disk.

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

Which script you use depends on how the host was installed, because the two cases differ in whether `/opt/shipway` is a git clone at all.

**Installed from a git remote** (`SHIPWAY_REPO_URL`):

```bash
sudo /opt/shipway/setup/update.sh
```

Pulls the latest commit as `deployer`, rebuilds (`npm ci && npm run build`), and restarts `shipway.service`.

**Installed from a local checkout** (the installer was run from a clone on the box, so `/opt/shipway` is an rsync of it and has no `.git`): update from that checkout instead.

```bash
sudo ./setup/deploy-local.sh            # sync, build, restart if needed, verify
sudo ./setup/deploy-local.sh --check    # show what would change, touch nothing
```

`update.sh` refuses in this case rather than failing halfway through a `git pull` that was never going to work.

`deploy-local.sh` finishes by fetching the live site over HTTPS and comparing the fingerprinted bundle it serves against the one just built, so "deployed" means the site is actually serving this source — a sync that silently didn't take is reported as a failure. It restarts the service only when the compiled server actually differs from the build the running process was started with (a fingerprint recorded at each restart, not a guess from which files rsync moved) — so a tree that was synced by some other means and never restarted is caught, while a rebuild that produces identical output doesn't cause a pointless restart. A web-only change needs no restart at all, because static files are read from disk per request. When it does restart, it stops the service and backs up `shipway.db` **with its `-wal` and `-shm` files** first — in WAL mode the `.db` alone can be nearly empty, so copying just that file yields a backup that looks fine and restores nothing. It also installs the pgAdmin helper scripts when they differ from the checkout, and reports (without installing) drift in the other root-owned files — see [Troubleshooting](#troubleshooting) for why those two are treated differently.

Database migrations run automatically the next time the process starts, there is no separate migrate step.

### If a change doesn't show up in the browser

The dashboard's `index.html` is served `no-cache` and every fingerprinted asset under `assets/` is served `immutable` (`server/src/app.ts`, pinned by tests in `server/test/spa-fallback.test.ts`). That combination is what makes a deploy appear on the next reload: the one file whose name never changes is always revalidated, and the files that never change under one name are never re-fetched. If a page still looks stale after a deploy that verified, reload once — and if that fixes it, the headers regressed and the tests above should have caught it.

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
| `/opt/phpmyadmin/` | phpMyAdmin, the MySQL console served at `ship.<base-domain>/db/phpmyadmin` |
| `/opt/shipway-db-signon/signon.php` | The shim behind `ship.<base-domain>/db/signon.php` that opens phpMyAdmin already signed in to one database |
| `/opt/pgadmin/venv/`, `/var/lib/pgadmin/` | pgAdmin 4's venv and its config database, served at `ship.<base-domain>/db/pgadmin` |
| `/opt/pgadmin/sync-servers.py` | Registers Shipway's Postgres databases as pgAdmin connections; run by the root helper on every create/drop |
| `/etc/nginx/shipway-auth/` | Per-project HTTP basic-auth files (Mailpit's lives at `/etc/nginx/shipway-mailpit.htpasswd`) |
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

**Using an external database server (RDS and friends).**
Databases > **Connections** lists every server a database can be created on. The two engines on this host are always there (the installer configured them and they aren't editable); **Add connection** registers another one — name, engine, host, port, an admin user that can create databases and roles, and TLS, which most managed instances require. **Test connection** tries the credentials on the spot, and saving tries them again, so a typo fails here rather than during a deploy. The admin password is stored encrypted with the same key as every other secret and is never shown again.

From then on, Databases > **New database** and Projects > New both ask which connection to use before anything else, and a database created on an external connection gets `DB_HOST`/`DB_PORT` pointed at that server in the project's env. The **Manage** console link only appears for databases on this host, since phpMyAdmin and pgAdmin are installed here and configured against these engines. Removing a connection only makes Shipway forget how to reach that server — nothing on the remote server is touched — and is refused while Shipway still has databases on it.

**PHP file permissions.**
Deploys run as `deployer`, but nginx serves PHP through php-fpm as `www-data`, so an app that writes at runtime (Laravel's `storage/`, above all) needs both users to have access. After the build and before the release goes live, Shipway grants `www-data` read/write on every shared path and on the release's `bootstrap/cache`, using POSIX ACLs with `default:` entries so files created later — by `www-data` at runtime, or by `deployer` on the next deploy — stay accessible to the other. It shows up in the deploy log as the `permissions` stage. If `setfacl` fails the deploy still goes out, with a warning in that log; an app that turns out to need it will otherwise fail its first request with `Failed to open stream: Permission denied`.

**Managing a database's contents.**
Databases > that database > **Manage** opens the console for that database's engine, signed in as you. Both consoles sit on the dashboard host behind the Shipway session, so there is no second browser prompt to get in — and no database password to type either.

For **MySQL**, the link goes to `ship.<base-domain>/db/signon.php?id=<database>`, a small shim that reads that database's credentials back from Shipway's own API using your session cookie and hands them to phpMyAdmin's signon authentication. You land on the database's table list, connected as that database's own user, so what you can reach is bounded by that account's grants exactly as before. Opening `ship.<base-domain>/db/phpmyadmin/` directly still shows the ordinary login form for any other MySQL account.

For **Postgres**, the link goes to `ship.<base-domain>/db/pgadmin/`. pgAdmin signs you in from the user nginx passes it (no pgAdmin password), and the server for each of Shipway's Postgres databases is already registered under a **Shipway** group in its browser tree, restricted to that one database and connecting through a passfile — so it opens without asking for anything. pgAdmin has no way to be sent to a specific database by URL, which is why this stops one click short of the MySQL experience. That registration is rebuilt whenever a database is created or dropped, whenever a user is added, and on every Shipway restart. pgAdmin's own login (the admin account from the install summary, re-readable in `/root/.shipway-install-secrets`) still works for reaching it directly.

pgAdmin's server list is also where **per-project access** reaches the console: a member scoped to specific projects (Settings > Team) gets only their own Postgres databases registered, rather than every database on the host with its password already in a passfile. That narrowing is applied by `/opt/pgadmin/sync-servers.py`, so it needs that script to be current — see below.

Because these consoles are host-side wiring rather than application code, most of a change to them is not picked up by `update.sh` or `deploy-local.sh`. Reapply it with `sudo /opt/shipway/setup/install.sh --consoles-only`, which redoes exactly that wiring (both consoles' config, the shim, the root helper, the dashboard vhost) and nothing else — no apt, no certbot, no DNS.

The two exceptions are `/opt/pgadmin/sync-servers.py` and `/opt/pgadmin/set-password.py`, which `deploy-local.sh` now installs itself when they differ from the checkout, restarting the service afterwards so the boot-time sync re-registers every account against the new script. They are singled out because server code can depend on a newer helper: shipping the server half of a change and leaving the old script in place produces no error anywhere, just behaviour that silently doesn't happen. Every other root-owned file (`shipway-sysops`, `shipway.service`, the signon shim, the nginx templates) is only ever published by `install.sh` — `deploy-local.sh` reports drift in them and refuses to install them, because each needs something more than a copy (a matching sudoers whitelist, a daemon-reload, per-project rendering).

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
