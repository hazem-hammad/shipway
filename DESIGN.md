# Shipway Design System

Register: **product** (design serves the task; earned familiarity over novelty).

## Theme decision

Scene: a developer glances at Shipway in a bright office or at night mid-incident, editor in the other window, waiting for a deploy's success line. The app itself is **light** — calm, paper-cool working surfaces that read instantly at a glance. The **deploy log terminal is the one dark object** in the product: a full-bleed near-black panel that glows out of the light page. This deliberately inverts the "devtool = all dark + neon" reflex; the terminal earns its darkness because it *is* a terminal.

## Color (OKLCH; never #000/#fff; neutrals tinted toward the harbor hue 220-240)

Strategy: **Restrained** with a semantic status vocabulary that does real work.

| Token | Value | Role |
|---|---|---|
| `--color-ink` | `oklch(0.25 0.02 240)` | Primary text |
| `--color-ink-soft` | `oklch(0.45 0.015 235)` | Secondary text, labels |
| `--color-paper` | `oklch(0.977 0.004 220)` | App background |
| `--color-panel` | `oklch(0.945 0.006 225)` | Sidebar, table headers, wells |
| `--color-line` | `oklch(0.88 0.008 225)` | Borders, dividers (1px only) |
| `--color-accent` | `oklch(0.52 0.10 215)` | Harbor teal: primary buttons, active nav, links, focus rings |
| `--color-accent-soft` | `oklch(0.93 0.03 215)` | Selected row tint, active tab bg |
| `--color-go` | `oklch(0.60 0.15 150)` | Starboard green: success |
| `--color-stop` | `oklch(0.55 0.18 25)` | Port red: failure, destructive |
| `--color-hold` | `oklch(0.70 0.13 75)` | Amber: running, queued, pending |
| `--color-term` | `oklch(0.21 0.02 235)` | Terminal background (the dark object) |
| `--color-term-text` | `oklch(0.88 0.02 160)` | Terminal default text (pale sea-glass) |

Status colors appear as **berth lights** (see Signature) and status text; never as large fills. Buttons: accent = primary, ink-outline = secondary, stop = destructive. No side-stripe borders, no gradient text, no glassmorphism.

## Typography

One engineered family pair, used everywhere (Google Fonts, self-hosted via @fontsource or link):

- **UI**: `IBM Plex Sans` (400 / 500 / 600). All labels, body, headings.
- **Data**: `IBM Plex Mono` (400 / 500). Everything machine-ish: slugs, SHAs, ports, URLs, env editor, scripts, cron expressions, credentials, and the entire log terminal.

Fixed rem scale, ratio ~1.2: 12 / 13 / 14 (base) / 16 / 20 / 24. Weight does hierarchy work before size does. Mono strings sit in subtle `--color-panel` chips when inline (sha, port, slug).

## Layout

- Left sidebar 220px (`--color-panel`, 1px line): wordmark "Shipway" + berth-light dot, then Projects / Databases / Server / Settings. Collapses to icons under 900px.
- Content area: page title row (title + primary action right-aligned), then content. Max width none for tables; forms cap at ~640px.
- Projects page is a **table**, not a card grid: berth light, name, slug.intcore.dev link (mono), type chip, last deploy (status + relative time + short sha), deploy button per row.
- Project detail: name + URL + berth light header, horizontal tabs (Deployments · Settings · Environment · Scripts · Workers · Cron · SMTP · Danger).
- Density is a feature. 8px spacing grid; tables row-height 44px; forms breathe (24px groups).

## Signature: berth lights + the terminal

1. **Berth light**: a 8px round lamp with a 3px soft outer glow of the same color at 25% alpha. Green = success/active, red = failed, amber = queued/running, gray = never deployed/unknown. Running/queued lamps pulse the glow (1.6s ease-in-out infinite; respects `prefers-reduced-motion`). Used identically in: sidebar wordmark (server reachable), projects table, deployment rows, worker instances, service health list. It is the product's one recurring identity mark.
2. **The terminal**: deploy logs render in a full-bleed `--color-term` panel, IBM Plex Mono 13px/1.6, `[HH:MM:SS]` timestamps at 45% alpha, `==> stage` lines in accent teal at 500 weight, `ERROR`/failure lines in port red. Auto-scroll pinned to bottom with a "jump to latest" affordance when scrolled up. No fake CRT effects.

## Components

Every interactive element ships default/hover/focus/active/disabled/loading states. Focus: 2px accent ring, visible always via keyboard. Skeletons (panel-tint shimmer) for loading lists; never centered spinners. Empty states: one sentence + the one next action ("No projects yet. Connect GitHub and create your first project."). Toasts bottom-right, 4s, mirror the action's verb ("Deploy queued", "Rolled back to #141"). Destructive confirms are inline panels with typed-name input only for delete project / drop database.

## Motion

150–200ms ease-out on state transitions only. The berth-light pulse and the log auto-scroll are the only ambient motion. No page-load choreography.

## Copy

CLI-calm: exact, active, no apologies, no filler. "Deploy #142 failed at build" / "Release 20260823_1405 is live" / "This deletes the app, its subdomain, and all releases. Type the slug to confirm." Buttons say what they do: Deploy, Roll back, Save env, Drop database.
