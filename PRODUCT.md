# Shipway

register: product

## Product Purpose

Shipway is a self-hosted deployment dashboard that replaces Coolify on intcore's single testing server. It deploys PHP/Laravel, Node, Next.js, and static projects from GitHub as native processes (no Docker), each on its own `*.intcore.dev` subdomain, with release-folder deploys and one-click rollback. It also manages databases (MySQL/Postgres), queue workers, cron jobs, per-project SMTP (Mailpit catch-all by default), and deploy notifications.

The whole point of Shipway versus Coolify: it is fast, small, and does only what this team actually uses.

## Users

A small trusted team of developers at intcore (an agency). They are technical, live in terminals and editors, and visit Shipway briefly and purposefully: to hook up a new client project, to watch a deploy they just pushed, to grab database credentials, to roll back something broken. Nobody "hangs out" in Shipway. Sessions are 30 seconds to 5 minutes, often triggered by a git push or a failing staging site, sometimes at night mid-incident.

The physical scene: a developer on a laptop or external monitor, editor open in the other window, glancing at a live deploy log streaming by, waiting for the green "success" line so they can get back to work.

## Tone

Calm, precise, technical. Shipway talks like a good CLI: says exactly what happened, never sells, never apologizes vaguely. "Deploy #142 failed at build" beats "Oops! Something went wrong." Labels use the team's own vocabulary: deploy, release, rollback, worker, cron, env.

## Anti-references

- Coolify's UI: crowded, slow, feature-flag soup. Shipway is the opposite: few screens, instant.
- Generic SaaS admin templates (shadcn-default gray cards, hero metrics, icon grids).
- Vercel/Netlify marketing gloss. Shipway is an internal tool, not a product selling itself.

## Strategic principles

1. The deploy log is the hero surface of the product. Watching a deploy stream live must feel great: legible, fast, honest.
2. Status must be readable at a glance from across the room: a deploy is queued, running, succeeded, failed, rolled back — color and shape carry that instantly.
3. Every destructive action (delete project, drop database, rollback) states exactly what it will do and requires typed confirmation only where the blast radius deserves it.
4. Secrets (env vars, database passwords, SMTP creds) are revealed deliberately, never displayed by accident.
5. No feature theater: if a screen has nothing to say, it says nothing (quiet empty states that point at the one next action).
