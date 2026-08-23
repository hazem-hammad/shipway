# Shipway — Design Spec

**Date:** 2026-08-23
**Status:** Approved for implementation
**Goal:** A fast, lightweight self-hosted deployment tool replacing Coolify on intcore's testing server (24 GB RAM / 8 cores, Ubuntu 24.04 LTS). Deploys PHP, Node, Next.js, and static HTML projects from GitHub with native processes (no Docker), manages MySQL/Postgres/SQLite/Redis, and exposes every project as a subdomain of `intcore.dev`.

---

## 1. Decisions (locked with the user)

| Topic | Decision |
|---|---|
| Runtime model | **Native processes** — no Docker. php-fpm per PHP version, Node apps as systemd units, static via nginx. Shared native MySQL/Postgres/Redis. |
| Routing | Subdomains of `intcore.dev`. Tool is **connected to Cloudflare** and creates DNS records itself. |
| SSL | One **wildcard cert** for `*.intcore.dev` via certbot DNS-01 (Cloudflare plugin), auto-renewed. |
| Tool stack | **Node.js monolith** — Fastify API + React SPA + webhook receiver + WebSocket logs + in-process deploy queue in one process. |
| Tool state | SQLite (single file). |
| Auth | Simple email/password users. All users see/manage all projects. No roles. |
| Runtime versions | Multiple side-by-side: PHP 8.1–8.4 (ondrej PPA), multiple Node versions under `/opt/node/<ver>`. Per-project selection. |
| Deploy style | **Release folders + atomic `current` symlink + instant rollback.** Keep last 5 releases. |
| Architecture | Single monolith service running as `deployer` user with a narrow sudoers file. |
| V1 extras | Queue workers, cron jobs, deploy notifications (webhook), per-project SMTP with **Mailpit** catch-all default. |
| Name | **Shipway.** |

### Non-goals (v1)
- No Docker, no multi-server support, no roles/permissions, no PR preview environments, no custom domains outside `intcore.dev`, no metrics/history graphs, no database backup scheduling, no terminal-in-browser, no file browser.

---

## 2. System overview

```
                       ┌─────────────────────────────────────────────┐
 GitHub push ──webhook──▶                                             │
 Browser ────HTTPS──────▶  nginx (deploy.intcore.dev) ──▶ Shipway     │
                       │     (Fastify, 127.0.0.1:8090)               │
                       │  ┌────────┬──────────┬──────────┬────────┐  │
                       │  │REST API│ React SPA│ WS logs  │ Queue  │  │
                       │  └────────┴──────────┴──────────┴────────┘  │
                       │        │ SQLite (/var/lib/shipway)          │
                       └────────┼────────────────────────────────────┘
                                │ shell (as deployer, scoped sudo)
      ┌───────────┬─────────────┼─────────────┬───────────────┐
      ▼           ▼             ▼             ▼               ▼
   git clone   nginx vhosts  php-fpm pools  systemd units   certbot /
   (GH App     + reload      (8.1…8.4)     shipway-app-*    Cloudflare
    token)                                  shipway-worker-* API
```

- **One process** (`shipway.service`, systemd) run as user `deployer`.
- Deploy jobs are spawned shell pipelines; **one deploy per project at a time, max 2 concurrent globally**.
- Live logs stream over WebSocket and are persisted to files.

## 3. Disk layout (server)

```
/opt/shipway/                      # the tool (git clone, built)
/var/lib/shipway/shipway.db        # SQLite state
/var/lib/shipway/secret.key        # 32-byte key for env encryption (0600)
/var/deploy/apps/<slug>/
    repo/                          # bare git mirror (fast fetches)
    releases/20260823_140501/      # one folder per deploy
    shared/                        # persists across releases
        .env                       # written by Shipway on deploy
        storage/  uploads/ ...     # user-configurable shared paths
    current -> releases/…          # atomic symlink
/var/deploy/logs/<slug>/<deployment-id>.log
```

Dev mode (on a laptop): everything under `./data/` in the repo, system commands mocked/no-sudo.

## 4. Data model (SQLite, via Drizzle ORM)

- **users** — id, name, email (unique), password_hash (argon2id), created_at
- **settings** — key, value (JSON). Holds: base_domain, server_ip, cloudflare_token, cloudflare_zone_id, github_app (id, slug, private_key, webhook_secret, installation_id), notification defaults (webhook_url, on_success bool), acme_email.
- **projects** — id, name, slug (unique, = subdomain), repo (`owner/name`), branch, type (`php|node|nextjs|static`), php_version / node_version, public_dir (php/static), port (assigned from 3001–3999 pool, node/nextjs), install_cmd, build_cmd, start_cmd (node), pre_deploy_script, post_deploy_script, shared_paths (JSON array), health_check_path (nullable), auto_deploy (bool), env_encrypted (BLOB — the raw `.env` text, AES-256-GCM), smtp_mode (`mailpit|custom|none`), smtp_config (JSON: host/port/user/pass/from, encrypted), notify_webhook_url (nullable override), created_at
- **deployments** — id, project_id, status (`queued|running|success|failed|rolled_back|canceled`), trigger (`push|manual|rollback`), commit_sha, commit_message, release_path, log_path, started_at, finished_at
- **databases** — id, project_id (nullable), engine (`mysql|postgres`), name, username, password_encrypted, created_at. (Redis is shared, shown on a static info card; SQLite is just a file in `shared/`.)
- **workers** — id, project_id, name, command, processes (count), status_cached
- **cron_jobs** — id, project_id, schedule (cron expr), command

Migrations via Drizzle Kit, applied automatically at startup.

## 5. Deploy pipeline

Every deploy (webhook push, manual button, or rollback) runs these steps as a job; each step streams to the log:

1. **Resolve commit** — installation token from GitHub App; `git fetch` into the bare mirror (`repo/`), resolve branch → SHA.
2. **Checkout** — export the resolved SHA from the bare mirror into a fresh `releases/<UTC timestamp>` folder: `git -C repo archive <sha> | tar -x -C <release>` (no `.git` in releases).
3. **Shared links** — symlink each `shared_paths` entry into the release; write `shared/.env` from decrypted env text **plus a managed block** (`# --- shipway managed ---`) containing SMTP vars (per smtp_mode) and any DB credentials the user chose to inject; symlink `.env` into the release root.
4. **Pre-deploy script** — user bash, `cwd` = release dir, `set -euo pipefail`, project env exported. Non-zero exit ⇒ deploy fails (release folder deleted, `current` untouched, site unaffected).
5. **Install & build** — per-type defaults, all overridable per project:
   - `php`: `composer install --no-dev --optimize-autoloader --no-interaction` (uses the project's PHP version binary, e.g. `php8.3 $(which composer)`)
   - `node` / `nextjs`: `npm ci && npm run build` (PATH prefixed with `/opt/node/<ver>/bin`)
   - `static`: optional build_cmd or nothing
6. **Activate** — `ln -sfn` new release to `current.tmp` + `mv -T` (atomic). Zero downtime.
7. **Restart runtime**
   - php: `sudo systemctl reload php<ver>-fpm` (clears opcache)
   - node/nextjs: `sudo systemctl restart shipway-app-<slug>` (unit runs start_cmd on the assigned port, `Restart=always`)
   - static: nothing
   - all: `sudo systemctl restart 'shipway-worker-<slug>-*'` if workers exist
8. **Health check** — if `health_check_path` set: GET `http://127.0.0.1:<port><path>` (node) or `https://<slug>.intcore.dev<path>` (php/static) with 5 retries / 3 s apart; failure ⇒ **auto-rollback** (flip symlink back, restart runtime, status `failed`). If unset: node apps just wait for the port to listen (15 s timeout); php/static skip.
9. **Post-deploy script** — user bash in the (now current) release. Failure marks deploy `failed` but does **not** roll back (code is live; the script is for cache warms, notifications, etc.).
10. **Prune** — keep newest 5 releases, delete older.
11. **Notify** — webhook (Slack-compatible JSON, plus Discord/Telegram formats auto-detected by URL) on failure always, on success if enabled.

**Rollback** = re-run steps 6–8 pointing at a previous release folder (picked in the UI). Instant.

**Cancel** = SIGTERM the running step's process group; release folder cleaned up.

## 6. Provisioning (what "create project" does)

1. Insert project row, assign port if node/nextjs.
2. **Cloudflare**: create proxied-off `A` record `<slug>.intcore.dev → server_ip` via API (token + zone id from settings). Deleting a project deletes the record (with confirm).
3. **nginx**: render vhost from the type's template into `/etc/nginx/sites-available/shipway-<slug>.conf` + symlink to `sites-enabled`, `sudo nginx -t`, then `sudo systemctl reload nginx`. Templates:
   - php: `root …/current/<public_dir>`, `fastcgi_pass unix:/run/php/php<ver>-fpm.sock`, Laravel-style try_files
   - node/nextjs: `proxy_pass http://127.0.0.1:<port>` with websocket upgrade headers
   - static: `root …/current/<public_dir>`, `try_files $uri $uri/ /index.html` optional SPA mode
   - all: SSL on with the wildcard cert paths; HTTP→HTTPS redirect
4. **systemd** (node/nextjs): render `shipway-app-<slug>.service` to `/etc/systemd/system/` (via `sudo install`), `daemon-reload`, enable. Unit: `User=deployer`, `WorkingDirectory=…/current`, `Environment=PORT=<port>`, `EnvironmentFile=…/shared/.env`, `ExecStart=/opt/node/<ver>/bin/<start_cmd…>`, `Restart=always`.
5. First deploy is triggered automatically.

`nginx -t` failure ⇒ config rolled back (file removed), error surfaced; never reload nginx with a broken config.

## 7. GitHub integration

- **GitHub App** (created once on the intcore org). Setup uses the **App Manifest flow**: dashboard button → redirect to GitHub with a generated manifest (permissions: `contents:read`, `metadata:read`; webhook URL `https://deploy.intcore.dev/api/webhooks/github`; events: `push`) → GitHub redirects back with a code → Shipway exchanges it and stores app id, private key, webhook secret automatically. Manual paste-the-fields fallback on the same page. Then the user installs the App on the org and Shipway stores the installation id.
- **Clone auth**: per-deploy installation access token; clone URL `https://x-access-token:<token>@github.com/<owner>/<repo>.git`. No SSH keys, no gh CLI dependency.
- **Repo picker**: project form lists the installation's repositories (searchable) and the chosen repo's branches.
- **Webhook**: verify `X-Hub-Signature-256` (HMAC, webhook secret). On `push` where ref matches a project's branch and auto_deploy is on ⇒ enqueue deploy (queued deploys for the same project are collapsed to the latest commit).

## 8. Databases & services

- **MySQL 8** and **PostgreSQL 16** run as normal apt-installed services. Shipway holds a locally-privileged admin credential (created by the setup script, stored in settings) and can: create database + dedicated user with a random password, show credentials (reveal on click), inject them into a project's env managed block (`DB_*`), and drop DB+user (typed-name confirm).
- **Redis** — one shared instance on 127.0.0.1, password set by setup script; shown as read-only info (host/port/password) to copy into env; projects separate by DB index/prefix.
- **SQLite** — nothing to manage: docs note that the file belongs in `shared/` so it survives releases.
- **Mailpit** — installed by setup script as systemd service; SMTP on `127.0.0.1:1025`, web UI proxied at `https://mail.intcore.dev`. Projects with `smtp_mode=mailpit` (default) get `MAIL_MAILER=smtp, MAIL_HOST=127.0.0.1, MAIL_PORT=1025, MAIL_ENCRYPTION=null` injected; `custom` injects the project's own SMTP creds; `none` injects nothing.

## 9. Workers & cron

- **Workers** (e.g. `php artisan queue:work --tries=3`, `node worker.js`): each renders a `shipway-worker-<slug>-<name>@.service` template unit; `processes` controls instance count (`@1..@n`). `User=deployer`, `WorkingDirectory=…/current`, `EnvironmentFile=shared/.env`, `Restart=always`, `RestartSec=3`. Restarted on every deploy. Start/stop/restart buttons + `journalctl -u` log tail in the UI.
- **Cron jobs** (e.g. `* * * * * php artisan schedule:run`): Shipway manages a marker-delimited block in the **deployer user's crontab** (`crontab -l/-`), one line per job: `cd /var/deploy/apps/<slug>/current && <command> >> /var/deploy/logs/<slug>/cron-<id>.log 2>&1`. No sudo needed. PHP commands use the version binary (`php8.3 artisan …` — the UI substitutes `php` automatically).

## 10. Web UI (React + Vite + Tailwind, served by Fastify)

Pages:
- **Login** / first-run **setup wizard** (create admin → server settings → Cloudflare token test → GitHub App manifest flow → done)
- **Projects** — cards: name, URL (click-through), type badge, last deploy status/time, deploy button
- **Project detail** tabs:
  - *Deployments* — history table; live log view (xterm-style scrollback, WS); redeploy / rollback / cancel
  - *Settings* — repo/branch, type + versions, commands, public dir, health check, auto-deploy toggle
  - *Environment* — raw `.env` textarea (monospace) + read-only preview of the managed block
  - *Scripts* — pre-deploy / post-deploy editors (bash, monospace)
  - *Workers* / *Cron* — CRUD + status
  - *SMTP* — mode picker + custom fields
  - *Danger* — delete project (removes vhost, units, DNS record, files; typed-name confirm)
- **Databases** — list/create/drop; Redis + Mailpit info cards
- **Server** — CPU/RAM/disk gauges (`/proc`, `df`), service health list (nginx, php-fpm ×N, mysql, postgres, redis, mailpit), Shipway version
- **Settings** — users CRUD, Cloudflare, GitHub App, notifications, general

Design: clean dark-capable dashboard; no heavy component library — Tailwind + a few headless primitives. Live deploy log is the hero interaction.

## 11. Security

- Argon2id password hashes; session cookie (`@fastify/secure-session`, httpOnly, Secure, SameSite=Lax); login rate-limited.
- All non-webhook API routes require a session. Webhook route requires a valid HMAC signature.
- Env blobs and SMTP/DB passwords encrypted at rest (AES-256-GCM, key file `0600`).
- Shipway runs as `deployer`; sudoers file (installed by setup) allows **only**:
  `systemctl (reload nginx|reload php8.*-fpm|start/stop/restart/enable/disable shipway-app-*|shipway-worker-*|daemon-reload)`, `nginx -t`, `install/rm` of `/etc/systemd/system/shipway-*.service` and `/etc/nginx/sites-*/shipway-*.conf` via a tiny whitelisted helper script (`/usr/local/bin/shipway-sysops <verb> …` — root-owned, validates paths/args, the *only* thing sudo-callable with arguments).
- User scripts run as `deployer` — same trust level as the team (internal tool).
- Slug validation `^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$` everywhere it touches paths/units/configs; all rendered configs escape values.

## 12. Setup & self-hosting

`setup/install.sh` (idempotent, Ubuntu 24.04, run as root):
1. apt: nginx, git, curl, MySQL 8, PostgreSQL 16, Redis (+password), certbot + cloudflare plugin, ondrej/php PPA → PHP 8.1/8.2/8.3/8.4 fpm+common extensions, composer, Mailpit binary.
2. Node versions → `/opt/node/22` (also runs Shipway), `/opt/node/20`, `/opt/node/18`.
3. Create `deployer` user, dirs, sudoers file, `shipway-sysops` helper.
4. Prompt for: base domain, server IP, Cloudflare API token, ACME email → issue wildcard cert (`certbot certonly --dns-cloudflare -d '*.intcore.dev' -d intcore.dev`), auto-renew timer with nginx reload hook.
5. Clone Shipway → `/opt/shipway`, `npm ci && npm run build`, install `shipway.service`, vhosts for `deploy.` + `mail.`, start.
6. Print the URL — first browser visit runs the setup wizard.

**Updates**: `sudo /opt/shipway/setup/update.sh` = git pull, npm ci, build, migrate, restart. (Dashboard shows current version + "update available" from GitHub releases; the update itself stays CLI for safety.)

## 13. Error handling principles

- A failed deploy must never leave the site broken: failures before *Activate* delete the new release; failures at/after activation offer/perform rollback.
- Every external mutation (Cloudflare, nginx, systemd) is verified (`nginx -t`, API response, `is-active`) and surfaced in the deploy/provision log with the exact command + stderr.
- The queue survives restarts: `queued`/`running` rows are re-queued/marked `failed` (`interrupted by restart`) on boot.

## 14. Testing strategy

- **Vitest** unit tests for all pure logic: nginx/systemd/crontab template rendering, env merge + managed block, encryption round-trip, webhook signature, slug/port allocation, pipeline step planning, notification payloads.
- **Integration tests** for the pipeline against local fixture git repos in temp dirs, with a `SysOps` interface (real impl shells out with sudo; fake impl records calls) — the pipeline is fully testable on the dev laptop without root.
- **API tests** via Fastify's `inject` (auth, projects CRUD, webhook flow with signed payloads).
- TDD throughout per superpowers workflow. UI gets type-checking + a build gate (heavy E2E out of scope for v1).

## 15. Tech stack summary

TypeScript everywhere. Fastify 5, `@fastify/websocket`, `@fastify/secure-session`, zod. Drizzle ORM + better-sqlite3. Octokit (`@octokit/auth-app`, `@octokit/rest`). Cloudflare REST via `cloudflare` npm pkg. `execa` for processes. React 18 + Vite + Tailwind CSS 4, TanStack Router/Query. argon2. Monorepo layout: `server/`, `web/`, `setup/`, `docs/`.
