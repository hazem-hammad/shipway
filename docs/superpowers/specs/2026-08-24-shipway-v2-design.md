# Shipway v2 — Redesign + Missing Features Spec

**Date:** 2026-08-24
**Status:** Approved (user-directed)
**Goal:** Rebuild the entire dashboard UI to replicate the OpenShip design language (user supplied reference screenshots; translated into exact tokens in DESIGN.md), and add the product areas the user called out as missing: Home dashboard, team management with enforced roles, notification channels + event matrix, audit log, global deployments page, and light/dark mode. Backend behavior from v1 (pipeline, provisioning, queue) is unchanged except where these features require additions.

## 1. Decisions (locked with the user, 2026-08-24)

| Topic | Decision |
|---|---|
| Visual direction | Replicate OpenShip's design identically: layout, colors, spacing, icon style, component anatomy, light + dark themes. Shipway keeps its own name/wordmark (no OpenShip logo/trademark). DESIGN.md v2 is the binding token spec. |
| Sidebar | MAIN: Home, Projects, Databases, Deployments · SETTINGS: Settings, Audit log · gradient "New Project" button · ACCOUNT card at bottom. Collapsible; theme toggle in header. Backups/Issues/Billing/Apps: excluded. |
| Server monitoring | Moves to Settings → Instance (mirrors OpenShip's settings rail). System status summary also appears on Home. |
| Team roles | Owner / Admin / Member, ENFORCED server-side. First user = owner. Admin+: manage team, settings, delete projects, drop databases, audit config. Member: create projects, deploy, rollback, env/scripts/workers/cron, view everything. Owner cannot be demoted/removed; only owner can change admins. |
| Invites | No email infra: "Invite member" creates a pending user (email + role) with a one-time invite token; UI shows a copyable link `/invite/<token>` where the invitee sets name + password (token expires 7 days, single use). Pending members listed with a "Copy invite link" action. |
| Notifications | Named delivery channels (webhook URL; Slack-compatible / Discord / Telegram auto-detected as in v1) + per-event subscriptions matrix. Events: deploy_failed, deploy_succeeded, deploy_canceled, deploy_rolled_back (health-check rollback), service_down, service_recovered. Service events come from a 60s poller diffing systemd unit states. v1's per-project notifyWebhookUrl override still works (fires in addition). Global notify_webhook_url setting is migrated into a channel named "Default" on first boot if set. |
| Audit log | `audit_events` table; every mutating API action records actor, action, target, metadata. Page with category tabs (All, Deployments, Projects, Databases, Team, Settings), search, actor filter, time filter, per-row detail. Right rail: "Record activity" toggle + retention picker (30/90/365 days, default 90) with automatic purge (hourly timer + boot). |
| Global deployments | New page listing recent deployments across all projects (status, project, sha, trigger, duration, when), linking to each log. |
| Home dashboard | Time-of-day greeting with user name, Projects overview card (count + empty-state CTA pair "Create project" / "Import from GitHub" both → /projects/new), Activity rail card (projects count, deployments count, System status Operational/Degraded from service states), Quick Tip card, quick-action tiles row (New project, Deployments, Settings, Docs→README link). |
| Theme | Light + dark, class strategy (`dark` on `<html>`), persisted in localStorage, toggle in sidebar header, defaults to system preference. |
| New Project flow | Adapted OpenShip copy: source tabs (GitHub / Git URL*), repo browser (search, All/Public/Private filter, language dot, private badge, relative time, arrow), right rail (Connection status card, repo Overview counts, Quick Tip). Config step: framework tiles with real logos for the 4 native types (Laravel/PHP, Node.js, Next.js, Static), collapsible sections (Deploy configuration: install/build/start, Environment variables with "Paste .env", Health checks, Project name), right rail (repo + branch picker, Domain preview `<slug>.<base_domain>`, black Deploy button, Deploy summary card). *Git URL tab = paste any https git URL (public repos or token-embedded) — new lightweight repo source stored as project.repoUrl alternative to GitHub App repos; pipeline getCloneUrl uses it verbatim when set. |
| Fonts/icons | Outfit (Google Fonts) for UI, IBM Plex Mono retained for code/data (shas, env editor, terminal). lucide-react icons everywhere, 1.75px stroke. Framework logos via inline SVGs (simple-icons paths). |

## 2. Backend additions

### Schema (drizzle migration 0001)
- `users`: + `role` TEXT NOT NULL DEFAULT 'member' ('owner'|'admin'|'member'); + `status` TEXT NOT NULL DEFAULT 'active' ('active'|'invited'); + `inviteToken` TEXT NULL UNIQUE; + `inviteExpiresAt` INTEGER NULL. Boot migration: earliest user becomes 'owner' if no owner exists.
- `notification_channels`: id, name (unique), url, createdAt.
- `notification_subscriptions`: id, event TEXT, channelId FK cascade, UNIQUE(event, channelId).
- `audit_events`: id, actorId (nullable FK set null), actorName TEXT, action TEXT, targetType TEXT, targetName TEXT, meta TEXT (JSON), createdAt. Index on createdAt, action.
- `projects`: + `repoUrl` TEXT NULL (Git-URL source alternative; when set, repo may be '' and github not required).

### Services
- `lib/authz.ts`: `requireRole(minRole)` route helper; role order member<admin<owner. Route table: admin+ → users/team CRUD, settings PUT, github/cloudflare config, project DELETE, database DELETE, audit config; member+ → everything else mutating; all authed users read everything.
- `services/audit.ts`: `recordAudit(db, {actor, action, targetType, targetName, meta})`; `purgeAudit(db, retentionDays)`; wired into every mutating route (thin helper called in handlers). Login failures recorded with actorName = attempted email.
- `services/notifybus.ts`: `emitEvent(db, event, payload)` → looks up subscriptions → sendDeployNotification per channel (reuse v1 formatter). Pipeline notify integration: deploy terminal states emit matching events (in addition to legacy per-project override URL). Service poller: every 60s (skipped in tests; injectable interval) read systemUnitStatus for SYSTEM_UNITS, diff vs previous in-memory state, emit service_down/service_recovered.
- Invites: `POST /api/users/invite {email, role}` (admin+) → pending user + token; `GET /api/invite/:token` (public) → {email, valid}; `POST /api/invite/:token {name, password}` (public) → activates + logs in. `PATCH /api/users/:id/role` (owner for admin changes; admin for member↔member edits per rules), DELETE user (admin+, not owner, not self).
- Notifications API: channels CRUD (admin+), subscriptions PUT (admin+), GET matrix. Test-send endpoint per channel.
- Audit API: `GET /api/audit?category&actor&q&since&limit` (paged 50), `GET/PUT /api/audit/config {enabled, retentionDays}` (admin+).
- Global deployments: `GET /api/deployments?limit=100` with project name/slug joined.
- Home: `GET /api/overview` → {projects, deployments, servicesDown: string[], user: {name}}.

## 3. Frontend rebuild
Every page restyled to DESIGN.md v2. Pages: Login, Setup wizard, Invite accept, Home, Projects, New Project (2-step), Project detail (all tabs; terminal keeps dark surface in both themes), Deployments (global), Databases, Settings shell with right rail (General, GitHub, Cloudflare, Team, Notifications, Instance), Audit log. Old berth-light identity is retired; status dots use the neutral OpenShip style (plain 8px dots, semantic colors, no glow).

## 4. Non-goals (v2)
Backups, Issues page, Billing, Apps marketplace, API tokens, MCP, email delivery, per-project restricted RBAC, mobile-first layouts (must remain usable ≥1024px; sidebar collapses below).

## 5. Compatibility
All v1 API routes keep working; new role checks return 403 with `{error: 'requires admin'}` style messages. Existing single global webhook honored via migration to a Default channel. v1 tests updated where role enforcement changes expectations (test helpers create an owner by default).
