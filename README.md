# Shipway

Shipway is a self-hosted deployment dashboard that replaces Coolify on intcore's testing server. It deploys PHP/Laravel, Node, Next.js, and static projects straight from GitHub as native processes, no Docker, each one live on its own subdomain, with release-folder deploys and one-click rollback.

The whole point of Shipway versus a general-purpose PaaS is that it is fast, small, and does only what this team actually uses. It also manages MySQL and Postgres databases, queue workers, cron jobs, per-project SMTP (Mailpit catch-all by default), and deploy notifications, all from a single dashboard the team visits for thirty seconds at a time: hook up a new client project, watch a deploy stream by, grab a database credential, roll back something broken.

## Features

- **Home dashboard**: a greeting, an overview of recent projects, quick-action tiles, and an activity rail showing project/deployment counts and system status at a glance.
- **Deploys from GitHub** via a GitHub App, or from any **Git URL** for repos outside GitHub: push to a project's branch and Shipway builds and activates a new release automatically, or trigger one by hand.
- **DNS confirmation on project creation**: New Project shows the exact `A` record it will create, checks the Cloudflare connection live, and confirms the result (created, already existed, or why not) before landing on the first deploy.
- **A working `.env` before the first deploy**: a PHP project arrives with a complete Laravel env — a generated `APP_KEY`, this server's redis and Mailpit credentials, and drivers that only name services actually running — shown right in New Project as either a key/value table or raw text, editable before anything is created. The Laravel deploy commands (`migrate` pre-activation, `storage:link`/`queue:restart` after, seeding offered but commented out) come prefilled too.
- **A database with the project, optionally**: tick a box in New Project, pick MySQL or PostgreSQL and a name, and its credentials are written straight into that project's env in time for the first `php artisan migrate`.
- **Branch dropdown for any source**: the deploy branch is picked from a list for a GitHub App repo and for a pasted Git URL alike (the latter via `git ls-remote`, nothing cloned), with the remote's default branch preselected.
- **Zero-downtime releases**: each deploy lands in its own release folder; going live is an atomic symlink flip. Instant rollback to any of the last 5 releases.
- **PHP, Node, Next.js, and static projects**, each served as a native process (php-fpm, a systemd unit, or a plain nginx root) with multiple runtime versions installed side by side.
- **Live deploy logs** streamed over WebSocket while a deploy runs, and persisted to disk afterward. Canceling a deploy stops it immediately, including a stuck git fetch or a health check in progress.
- **Global deployments view** listing recent deploys across every project, alongside each project's own history.
- **Databases**: create/drop MySQL and Postgres databases with a dedicated user, reveal credentials on demand, inject them straight into a project's env.
- **Workers and cron**: background worker processes (systemd, restart-on-crash) and a managed crontab block, both editable per project.
- **Environment variables editor**: two views of a project's `.env` — a key/value table, one row per pair, with masking and reveal for secret-looking keys and duplicate-key warnings, and a raw text view for anything the table can't represent losslessly. The same editor is what New Project shows before the project exists.
- **Per-project SMTP** with Mailpit as the default catch-all inbox, or a project's own SMTP credentials.
- **Instance mail**: a separate SMTP configuration (Settings > Mail) Shipway itself uses to email invite links and route notification events to an address, with a test-send to confirm it before relying on it.
- **Team roles and invite links**: Owner, Admin, and Member roles enforced server-side; adding someone to the team is a copyable invite link, emailed automatically too once instance mail is configured, so no email infrastructure is required to get started.
- **Notification channels and event matrix**: named delivery channels (Slack/Discord/Telegram-compatible webhooks, Microsoft Teams, or email) subscribed per event (deploy failed/succeeded/canceled/rolled back, service down/recovered), with test-send from the dashboard.
- **Audit log**: every mutating action is recorded with actor, action, and target, filterable by category and searchable, with configurable retention and automatic purge.
- **Light and dark theme**, following the system preference by default with a manual toggle.
- **One wildcard SSL certificate** for every project's subdomain, issued and renewed automatically via Let's Encrypt DNS-01.

## Architecture

Shipway is a single Node.js monolith: a Fastify API, the React SPA, the GitHub webhook receiver, WebSocket log streaming, and an in-process deploy queue, all in one process, running as an unprivileged `deployer` user with a narrow, whitelisted sudoers policy for the handful of root-only operations (nginx/systemd config) it needs.

## Development

Shipway is a monorepo: `server/` (Fastify API + deploy engine) and `web/` (the React dashboard), plus `setup/` (the install scripts covered below) and `docs/`.

```bash
git clone <this repo>
cd shipway
npm install

# terminal 1: the API, in dev mode (mocked system commands, no sudo, no root
# required; state lives under ./server/data)
SHIPWAY_DEV=1 npm run dev -w server

# terminal 2: the web dashboard (Vite dev server, proxies API calls to the
# server above)
npm run dev -w web
```

Useful root-level scripts: `npm test` (server test suite), `npm run typecheck` (both workspaces), `npm run build` (both workspaces).

## Installing on a server

Shipway is meant to run on its own dedicated Ubuntu 24.04 box. Installation is one script, `setup/install.sh`, run as root; it provisions nginx, PHP 8.1-8.4, MySQL, PostgreSQL, Redis, Node, Mailpit, and a wildcard SSL certificate, then builds and starts Shipway itself.

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full walkthrough: prerequisites, the exact commands, the first-run wizard, updating, backups, troubleshooting, and where everything lives on disk.

## Updating

```bash
sudo /opt/shipway/setup/update.sh
```

Pulls the latest commit, rebuilds, and restarts the `shipway` service. Database migrations run automatically on startup, so there is no separate migrate step. See [DEPLOYMENT.md](DEPLOYMENT.md#updating) for details.
