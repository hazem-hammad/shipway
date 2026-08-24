# Shipway

Shipway is a self-hosted deployment dashboard that replaces Coolify on intcore's testing server. It deploys PHP/Laravel, Node, Next.js, and static projects straight from GitHub as native processes, no Docker, each one live on its own subdomain, with release-folder deploys and one-click rollback.

The whole point of Shipway versus a general-purpose PaaS is that it is fast, small, and does only what this team actually uses. It also manages MySQL and Postgres databases, queue workers, cron jobs, per-project SMTP (Mailpit catch-all by default), and deploy notifications, all from a single dashboard the team visits for thirty seconds at a time: hook up a new client project, watch a deploy stream by, grab a database credential, roll back something broken.

## Features

- **Deploys from GitHub** via a GitHub App: push to a project's branch and Shipway builds and activates a new release automatically, or trigger one by hand.
- **Zero-downtime releases**: each deploy lands in its own release folder; going live is an atomic symlink flip. Instant rollback to any of the last 5 releases.
- **PHP, Node, Next.js, and static projects**, each served as a native process (php-fpm, a systemd unit, or a plain nginx root) with multiple runtime versions installed side by side.
- **Live deploy logs** streamed over WebSocket while a deploy runs, and persisted to disk afterward.
- **Databases**: create/drop MySQL and Postgres databases with a dedicated user, reveal credentials on demand, inject them straight into a project's env.
- **Workers and cron**: background worker processes (systemd, restart-on-crash) and a managed crontab block, both editable per project.
- **Per-project SMTP** with Mailpit as the default catch-all inbox, or a project's own SMTP credentials.
- **Deploy notifications** to Slack/Discord/Telegram-compatible webhooks.
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

See **[docs/server-setup.md](docs/server-setup.md)** for the full walkthrough, including prerequisites, the GitHub App setup, and where everything lives on disk.

## Updating

```bash
sudo /opt/shipway/setup/update.sh
```

Pulls the latest commit, rebuilds, and restarts the `shipway` service. Database migrations run automatically on startup, so there is no separate migrate step.
