# Shipway v3 — Instance mail, Teams, DNS confirmation, cancel fix, env editor

**Date:** 2026-08-25
**Status:** Approved (user-directed, 6 items)
**Base:** main @ 695c812 (v2 merged). Branch: feat/v3.

## 1. The six requests (verbatim intent)

1. Instance SMTP in Settings: choose a mail driver + credentials, SEPARATE from per-project SMTP. Shipway itself uses them for deploy success/failure notifications, member invites, etc.
2. Microsoft Teams supported in Delivery channels.
3. BUG: Cloudflare settings says "Connected" for any credentials, even empty.
4. New Project: the subdomain is shown but Cloudflare isn't verified. Require/verify a Cloudflare connection, show the exact record that will be created, send the request, and show the result.
5. BUG: Cancel deployment doesn't work, or takes very long with no message or loader.
6. Enhance the environment-variables view.

## 2. Root causes (investigated before planning)

**#3 Cloudflare "Connected" always.** `app.dns()` (server/src/app.ts:262-271) returns a `FakeDnsClient` whenever `cfg.devMode` is true, and `FakeDnsClient.verifyToken()` unconditionally returns `true` (services/cloudflare.ts:129-131). `GET /api/cloudflare/verify` therefore reports `{ok:true}` in dev regardless of what (if anything) is stored. In production the empty case is correctly `{ok:false}`, but the route also gives no reason, so the UI cannot distinguish "not configured" from "token rejected".

**#5 Cancel is slow/ineffective.** The abort signal reaches only `runShell` (execa `cancelSignal`) and the pipeline's `checkAborted` stage boundaries. It does NOT reach:
- `GitOps` (services/git.ts) — `git clone --mirror` / `fetch` / `archive` run with no `cancelSignal`, so a slow or unreachable remote blocks the whole pipeline until git itself gives up. This is the dominant case (a `resolve` stage cancel appears to do nothing).
- `deps.sleep` (health-check retry: 5 × 3s) and `deps.fetchHttp`.
- `defaultWaitForPort` (up to 15s).
Additionally `runShell` sends only SIGTERM (no SIGKILL escalation), and the UI's Cancel button has no pending state, so a cancel that is working still looks dead.

## 3. Decisions

| Topic | Decision |
|---|---|
| Instance mail | New settings block `instance_mail`: `driver` ('smtp' \| 'mailpit' \| 'none', default 'none'), host, port, username, password (encrypted), fromAddress, fromName, secure (bool). Sent via **nodemailer**. Settings → a new **Mail** section (its own right-rail row) with a "Send test email" action taking a destination address. Entirely separate from per-project SMTP (which stays exactly as-is: it only writes MAIL_*/SMTP_* into a project's .env). |
| What uses instance mail | (a) Team invites: when mail is configured, `POST /api/users/invite` also emails the invite link; the UI still shows the copy-link (email is additive, never the only path). (b) A new delivery-channel type `email` so the notifications matrix can route any event (deploy failed/succeeded/etc.) to an address. |
| Delivery channels | Channels gain `type`: `webhook` (existing; Slack/Discord/Telegram auto-detected by URL) \| `teams` \| `email`. Teams: detected automatically from `*.webhook.office.com`, `*.logic.azure.com`, or explicit type choice; payload = MessageCard JSON (`@type: MessageCard`, themeColor by severity, `summary`, `title`, `text`). Email: `target` holds the address; requires instance mail configured (405-style calm error otherwise). The Add-channel form gains a type picker with helper text per type. |
| Cloudflare verify | `GET /api/cloudflare/verify` returns `{ok, reason}` where reason ∈ 'not_configured' \| 'invalid_token' \| 'ok' \| 'error:<message>'. It checks the stored settings FIRST (independent of devMode) and returns `not_configured` when token or zone id is missing/blank. Dev mode no longer fakes success: with credentials present it performs the real API call; with none it reports `not_configured`. `FakeDnsClient` gains `configured` state so provisioning still works offline while verify stays honest. UI shows a neutral "Not connected" chip, an amber "Not configured" hint, or a green "Connected" only after a real success. |
| New Project DNS | Step 2's Domain card shows the exact record (`A  <slug>.<base_domain>  →  <server_ip>`), plus live Cloudflare status (from the verify route). Not connected → inline warning + a "Connect Cloudflare" link, and the Deploy button requires an explicit "Create anyway (no DNS record)" checkbox. On create, the API response now includes `dns: {attempted, created, existed, error?}` from the provisioner, and the UI shows the outcome as a result row ("DNS record created", "Record already existed", or the API error) before navigating. |
| Cancel deployment | (a) Thread `AbortSignal` through `GitOps` (all execa calls get `cancelSignal`), `deps.sleep`, `deps.fetchHttp`, and `waitForPort`. (b) `runShell` escalates: `forceKillAfterDelay: 5000` so a hung child is SIGKILLed. (c) New status value is NOT added; instead the deployments row/API reports `cancelRequested` (in-memory queue state exposed via the deployment GET/list) so the UI can show "Canceling…". (d) UI: Cancel button becomes a disabled "Canceling…" spinner immediately (optimistic), and the log page shows a `==> cancel requested` line. (e) The pipeline logs 'cancel requested, stopping after the current step' when the signal fires. |
| Env editor | The Environment tab gets two modes on one card: **Table** (default) and **Raw**. Table = rows of key/value with add row, inline delete, duplicate-key warning, value masking for keys matching /(SECRET\|TOKEN\|KEY\|PASSWORD\|PASS\|DSN\|CREDENTIAL)/i with per-row reveal, monospace inputs, and a count line. Raw = today's textarea. Switching modes converts losslessly for well-formed lines; lines that can't be parsed (comments, blanks, `export` forms, multiline quotes) are preserved verbatim and shown in a "Not editable as rows" note in Table mode so nothing is silently dropped. One Save for both modes; the managed-block preview stays below. |

## 4. Non-goals
Per-project mail-driver override (project SMTP already does that), IMAP/inbox features, email templates beyond a plain text + minimal HTML body, Teams Adaptive Cards (MessageCard is enough), DNS providers other than Cloudflare, editing `repoUrl` credentials post-create.

## 5. Compatibility
All existing routes/shapes keep working. `notification_channels` gains `type` (default 'webhook') and `target` (nullable; email address) via migration 0002 — existing rows keep behaving exactly as before. Instance mail defaults to driver 'none' (no behavior change until configured). The cancel changes alter no persisted shapes.
