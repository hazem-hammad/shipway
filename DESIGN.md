# Shipway Design System v2 — OpenShip replica

Register: **product**. This document is the binding, pixel-level translation of the user's OpenShip reference screenshots. Implementers build to THIS document; when in doubt, match the anatomy described here exactly. Shipway keeps its own name; everything else replicates the reference.

## Overall character

Soft, airy, neutral. A very light warm-gray page with floating white rounded cards; generous whitespace; thin gray outline icons; grayscale-first with tiny pops of semantic color; one loud gradient CTA. Dark mode is a true re-skin (near-black surfaces, lime CTA), not an inversion filter.

## Theme mechanics

- Tailwind `dark` class strategy on `<html>`; persisted `localStorage['shipway.theme']` = 'light'|'dark'|null(system). Toggle button (sun/moon-stars lucide icon) in the sidebar header with a small "Toggle theme" tooltip. Respect system preference when unset.

## Color tokens (CSS custom properties; light / dark)

| Token | Light | Dark |
|---|---|---|
| `--bg` page background | `#F7F7F8` | `#0F0F10` |
| `--surface` cards/sidebar | `#FFFFFF` | `#1A1A1C` |
| `--surface-2` nested wells, hover rows, inner cards | `#F4F4F5` | `#232326` |
| `--surface-3` active nav item, pressed | `#EDEDEF` | `#2A2A2E` |
| `--border` | `#ECECEE` | `#26262A` |
| `--text` primary | `#18181B` | `#F4F4F5` |
| `--text-soft` secondary/descriptions | `#8E8E93` | `#8E8E93` |
| `--text-faint` section labels, placeholders | `#A8A8AD` | `#6E6E73` |
| `--icon` default icon stroke | `#6B6B70` | `#A0A0A5` |
| `--primary` solid buttons (Create project, Add credential, Deploy) | `#141416` (near-black, white text) | `#FFFFFF` (black text) |
| `--cta-from` → `--cta-to` gradient New Project button | `#8B5CF6` → `#3B82F6` (left→right) | replaced by solid `#C8F135` lime, black text |
| `--ok` | `#22C55E` | `#4ADE80` |
| `--warn` | `#F59E0B` | `#FBBF24` |
| `--danger` | `#EF4444` | `#F87171` |
| `--ok-tint` badge bg (e.g. "Used for deploys", "Connected") | `#E8F8EE` text `#1B9E4B` | `#173322` text `#4ADE80` |
| `--accent-tint` misc icon chip bgs | orange `#FFF3E8`/icon `#F59E0B`; purple `#F3EFFF`/icon `#8B5CF6`; green `#E8F8EE`/icon `#22C55E` — used sparingly on section-header icon squircles | same hues at 15% alpha |

Terminal (deploy log) keeps its own fixed surface in BOTH themes: bg `#141416`, default text `#D6E4DC`, stage lines `#8B9DF8`-ish accent → use `#A5B4FC`, errors `#F87171`, timestamps 45% alpha.

## Typography

- UI face: **Outfit** (Google Fonts; weights 400/500/600). Rounded geometric — matches the reference's headings and labels.
- Data/mono: **IBM Plex Mono** for shas, env editor, tokens (`ghp_…` placeholders), cron, terminal.
- Scale: page title 28px/600; page subtitle 15px/400 `--text-soft`; card title 16px/600; card description 13.5px/400 `--text-soft`; body 14px; nav item 14.5px/500; section label 11px/600 uppercase tracking `0.08em` `--text-faint`; table header 12px/500 uppercase `--text-soft`.

## Iconography

**lucide-react**, size 20 (18 in dense rows), strokeWidth 1.75, color `--icon`. Section-header icons sit in a 40px squircle (`rounded-xl`, `--surface-2` bg). Nav icons plain (no chip). Framework/brand logos: inline SVG paths from simple-icons, full color, inside 56px `rounded-2xl` `--surface-2` tiles.

## Layout anatomy

### App shell
- Page bg `--bg`. Sidebar is a **floating card**: fixed width 280px, margin 12px, `rounded-2xl` (20px), `--surface`, border `--border`, full-height column.
- Sidebar structure top→bottom:
  1. Header row: wordmark (24px circle outline logo glyph — a simple `Circle` lucide stroke — + "Shipway" 17px/600) · spacer · theme-toggle icon button · collapse icon button (`PanelLeftClose`). Icon buttons: 32px, `rounded-lg`, hover `--surface-2`.
  2. Divider (`--border`, inset 16px).
  3. `MAIN` section label; nav items: Home (`LayoutGrid`), Projects (`FolderGit2`), Databases (`Database`), Deployments (`Rocket`). Item: 40px tall, `rounded-xl`, icon+label gap 12px, padding-x 12px; active = `--surface-3` bg + `--text` + 500; inactive = `--text-soft`, hover `--surface-2`.
  4. `SETTINGS` label; items: Settings (`Settings`), Audit log (`ClipboardList`).
  5. Flexible spacer.
  6. **New Project** button: full-width pill (`rounded-full`, 44px), gradient `--cta-from→--cta-to` (dark: solid lime), white (dark: black) 15px/600, `Plus` icon. 
  7. Divider, `ACCOUNT` label.
  8. Account card: 36px avatar circle (`--surface-3`, initial letter), name (truncated, 14px/600) over email (12px `--text-soft`), `ChevronsUpDown` at right; click → menu (Profile-less: just Sign out). Deviation from a floating popover: the menu renders in-flow directly above the account button (the nav spacer absorbs the height when expanded; a flyout to the right when the sidebar is collapsed), so it never overlaps the New Project CTA and the account button itself stays pixel-stable. Theme toggle lives in the sidebar header (item 1 above), not in this menu.
- Collapsed sidebar: 76px wide, icons only, tooltips.
- Content column: max-width 1440px, padding 32px 40px; grid with optional **right rail** (fixed 380px) on pages that have one (Home, New Project, Settings, Audit log).

### Page header
Title 28px/600 + subtitle line under it; optional kebab `MoreVertical` icon button far right. No colored banners.

### Cards
`--surface`, border `--border`, `rounded-2xl` (16px), padding 24px, no shadow in light (shadow-sm at most), gap-stacked 20px. **Card header pattern**: 40px icon squircle + title (16px/600) + description line (13.5px `--text-soft`), action button top-right (e.g. "+ Add", "Invite member").
Inner list rows: `--surface-2` `rounded-xl` rows (e.g. GitHub account row) with left icon chip, title/subtitle, right badge.

### Buttons
- Primary: `--primary` bg, `rounded-xl`, 40px, 14px/600, icon+label. (Black in light / white in dark.)
- Secondary: `--surface-2` bg, `--text`, same shape (e.g. "Import from GitHub", "Manage on GitHub ↗").
- Outline/ghost: border `--border` on `--surface` (e.g. "+ Add", "Change method ⌄", "Cancel").
- Destructive text: plain `--danger` label with icon (e.g. "Disconnect"), no fill.
- Disabled: 45% opacity.
- Focus: 2px ring `#3B82F6` at 40% (light) / lime 40% (dark), always keyboard-visible.

### Forms
Label 13.5px/500 above; input 44px, `rounded-xl`, border `--border`, bg `--surface` (nested contexts: `--surface-2`), focus ring as above; helper text 13px `--text-soft` below; mono placeholders for tokens. Toggles: 44×24 pill, ON = `--text` (near-black; dark: white), knob white (dark: black). Checkboxes `rounded-md`.

### Tables & lists
Prefer borderless rows separated by `--border` hairlines inside a card; row hover `--surface-2`; 56px row height; first cell often icon chip + name; right-aligned meta (relative time, chevron `ArrowRight` ghosted).

### Badges/chips
Pill `rounded-full`, 12.5px/500: neutral (`--surface-2` + `--text-soft`, e.g. "Private", "Org"), success tint (`--ok-tint`, e.g. "Connected", "Used for deploys"). Language dots: 8px colored dot + label (`TypeScript` #3178C6, `PHP` #777BB4, `Dart` #0175C2, `JavaScript` #F1E05A, `Nunjucks`/other #8E8E93).

### Status dots
Plain 8px dots (no glow): ok `--ok`, running/queued `--warn` (subtle 1.6s opacity pulse, reduced-motion respected), failed `--danger`, idle `--border`-gray. "Operational"/"Degraded" text in matching color.

### Right-rail cards
Same card style; used for: identity summary (icon + title + email), sub-navigation (Settings rail: rows 44px `rounded-xl`, active `--surface-3`), Activity (icon-chip rows with big right-aligned numbers 18px/600), Quick Tip (slightly tinted `--surface-2` card, `Zap` icon, one sentence + arrow link), Overview counts, Deploy summary.

### Empty states
Centered in the card: small monochrome illustration built from the icon language (e.g. Home: central circle node with 4 dashed connectors to Repo/Domain/Deploy/Data mini-squircles), headline 22px/600, 15px `--text-soft` two-line explainer, CTA pair (primary + secondary), optional keyboard hint line ("Tip: press ⌘K to jump anywhere" style — only if the shortcut exists).

### Settings shell
Content column + right rail. Rail: identity card (Settings + user email) above a sub-nav card: General (`Settings`), GitHub (`GitBranch`), Cloudflare (`Cloud`), Team (`Users`), Notifications (`Bell`), Instance (`Server`). Each section renders as stacked cards in the main column (header pattern + content), exactly like the reference's GitHub/Credentials/Team/Notifications screens: e.g. Team = invite card (email input + role radio-cards Member/Admin with icon chips + descriptions, Cancel/Send invite buttons) above "Active members (n)" list card with avatar, name "(you)", email, right-aligned UPPERCASE role label.

### Notifications matrix
Card 1: "Delivery channels" header + "+ Add channel" → rows of channels. Card 2: "What to be notified about" + category tabs with count pills (All, Deployment, Services) + table: EVENT (name 15px/600 + description 13px soft) | DELIVERY CHANNELS ("n channels ⌄" chip, chevron expands in-flow to a per-channel checkbox list rather than a popover dropdown) | ENABLED (toggle). The toggle isn't independent state: it reads `subscribedCount > 0`, so switching it ON subscribes every channel and switching it OFF unsubscribes all of them, a shortcut over the same per-channel subscriptions rather than a separate enabled flag.

### Audit log
Header + category tabs with count pills · filter row (search input with `Search` icon, actor select "Anyone", time select "All time") · results card (rows: icon chip by category, action sentence, actor, relative time; empty: "Nothing has been recorded yet."). Right rail: "Record activity" card with toggle + description + "Keep entries for [90 days ⌄]" + "Older entries are deleted automatically."

### Motion
150–200ms ease-out; hover/active transitions and the running-dot pulse only. No page choreography.

### Copy
Unchanged rules: exact, active, sentence case, no em dashes, buttons say what they do. Greeting on Home: "Good morning/afternoon/evening, {name}" + "Here's what's happening across your projects".

## Bans (unchanged)
No side-stripe borders, no gradient text, no glassmorphism, no modals where inline/progressive works (the invite form, confirms, and channel add are inline cards/rows), no em dashes in copy.
