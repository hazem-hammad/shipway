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

**Combobox** (searchable dropdown, `Combobox` in `ui.tsx`): used in place of a native `<select>` wherever the list can run long — the New Project branch pickers, above all. Trigger looks exactly like an input (44px, `rounded-xl`, optional leading icon, chevron that flips when open); the panel is our own popover — `rounded-xl`, `--surface`, `--border`, `shadow-lg`, offset 6px — with a `Search` field on top, rows of 36px `rounded-lg` (hover/keyboard-active `--surface-2`, selected in 500 with a `Check` at the right), a scrolling list capped at 256px, and a hairline footer counting matches ("12 of 340 branches"). Filtering ranks prefix matches first; Arrow/Home/End/Enter/Escape all work, and the list closes on an outside click. With `allowCustom`, text matching nothing is offered as its own row ("Use this branch") so a hand-typed value still commits.

**New Project rail — Domain / Deploy summary**: the Domain card leads with the project URL on a `--surface-2` tile (`Lock` glyph, faint `https://` + mono domain, icon-only copy at the right), then the A record as an actual record — a bordered `--surface-2` block headed "DNS RECORD" (section-label) with the Cloudflare badge at its right, and `Type` / `Name` / `Value` as three labelled mono fields rather than one run-on line. The "no record will be created" gate is a `--warn` tinted panel (5% bg, 30% border) carrying its acknowledgment checkbox; after create, the outcome sits below the record as a tinted line with a `Check`/`X`/`Minus`. Deploy summary is icon rows (Domain, Branch, Framework — the framework's own brand mark, Build command, Database) separated by `--border` hairlines, value right-aligned, absences ("none", "not set") in `--text-faint` so configured and unconfigured read apart at a glance.

### Tables & lists
Prefer borderless rows separated by `--border` hairlines inside a card; row hover `--surface-2`; 56px row height; first cell often icon chip + name; right-aligned meta (relative time, chevron `ArrowRight` ghosted).

### Badges/chips
Pill `rounded-full`, 12.5px/500: neutral (`--surface-2` + `--text-soft`, e.g. "Private", "Org"), success tint (`--ok-tint`, e.g. "Connected", "Used for deploys"), danger tint (`--danger` at 10% opacity bg + `--danger` text, e.g. "Cloudflare error" on New Project's Domain card, or Cloudflare settings' "Cloudflare rejected this token" state) for a failed/error status that deserves the same pill treatment as a success one rather than falling back to plain alert text. Language dots: 8px colored dot + label (`TypeScript` #3178C6, `PHP` #777BB4, `Dart` #0175C2, `JavaScript` #F1E05A, `Nunjucks`/other #8E8E93).

### Status dots
Plain 8px dots (no glow): ok `--ok`, running/queued `--warn` (subtle 1.6s opacity pulse, reduced-motion respected), failed `--danger`, idle `--border`-gray. "Operational"/"Degraded" text in matching color.

### Right-rail cards
Same card style; used for: identity summary (icon + title + email), sub-navigation (Settings rail: rows 44px `rounded-xl`, active `--surface-3`), Activity (icon-chip rows with big right-aligned numbers 18px/600), Quick Tip (slightly tinted `--surface-2` card, `Zap` icon, one sentence + arrow link), Overview counts, Deploy summary.

### Empty states
Centered in the card: small monochrome illustration built from the icon language (e.g. Home: central circle node with 4 dashed connectors to Repo/Domain/Deploy/Data mini-squircles), headline 22px/600, 15px `--text-soft` two-line explainer, CTA pair (primary + secondary), optional keyboard hint line ("Tip: press ⌘K to jump anywhere" style — only if the shortcut exists).

### Settings shell
Content column + right rail. Rail: identity card (Settings + user email) above a sub-nav card: General (`Settings`), GitHub (`GitBranch`), Cloudflare (`Cloud`), Mail (`Mail`), Team (`Users`), Instance (`Server`). Each section renders as stacked cards in the main column (header pattern + content), exactly like the reference's GitHub/Credentials/Team/Notifications screens: e.g. Team = invite card (email input + role radio-cards Member/Admin with icon chips + descriptions, then — for a Member — a second radio-card pair All projects/Specific projects over a scrollable checkbox list of projects, Cancel/Send invite buttons) above "Active members (n)" list card with avatar, name "(you)", email, right-aligned UPPERCASE role label, and a project-access line under each row with an inline "Change" editor. Admins show a plain "All projects" label instead of a picker: they reach every project by role, so there is nothing to choose.

### Project domain
A card in the project's Settings tab (`Globe`), between General and Build & runtime. One mono "Subdomain" field, its hint showing the full `<subdomain>.<base-domain>` it resolves to as you type. Because saving it breaks every existing link to the site, the consequences are stated before the button rather than after: while the field is dirty and valid, a tinted `--surface-2` panel lists what saving will do (point the new record at this server and remove the old one, rewrite the domain in the env, break existing links — and that the project's internal name does not change). The button reads "Move project", not "Save". Afterwards the same slot holds the result — a "Moved" badge with the live domain, one line each for what happened to DNS and to the env, and the old record as a `--danger` line if it could not be removed — since two parts of the move are conditional and a card that just went clean would not say which ran. Admin-only: members get the `Lock` read-only notice in place of the button.

### Project notifications
Lives as a card in a project's Settings tab, not in the Settings shell — notifications are per project. Card header (`Bell`) + "Recipients": a stack of email inputs, each with a bare `X` remove button, under an "Add email" secondary button; then "Send an email when" with one checkbox per deploy event (failed, succeeded, canceled, rolled back). Save + "Send test email" share the footer row, the test disabled until changes are saved and at least one recipient exists. When instance mail isn't configured, a tinted `--surface-2` note sits above the form saying nothing will actually be sent and pointing at Settings > Mail.

### Audit log
Header + category tabs with count pills (a "Clear filters" link right-aligned on that row once anything is filtered) · filter row (search input with `Search` icon, actor select "Anyone", time select "All time") · results as a **timeline grouped by day**: a `SectionLabel` heading per day ("Today", "Yesterday", "Monday, 24 August") above its own card of rows. Row: action icon chip · action sentence · meta chips · 24px actor avatar · clock time (`14:32`, mono, with the full timestamp to the second as its `title`). Relative time is deliberately absent — the day heading carries recency and the clock time carries precision, which is what an audit trail is asked for. Colour is spent on one distinction only: destructive and security-relevant actions (drop, delete, cancel, rollback, failed sign-in) get a `danger`-toned icon chip and a medium-weight sentence; everything else is neutral. Filters live in the query string. Empty: "Nothing recorded yet" unfiltered, "No matching activity" + Clear filters when filtered. Right rail: "Record activity" card with toggle + description + "Keep entries for [90 days ⌄]" + "Older entries are deleted automatically."

### Motion
150–200ms ease-out; hover/active transitions and the running-dot pulse only. No page choreography.

### Copy
Unchanged rules: exact, active, sentence case, no em dashes, buttons say what they do. Greeting on Home: "Good morning/afternoon/evening, {name}" + "Here's what's happening across your projects".

## Bans (unchanged)
No side-stripe borders, no gradient text, no glassmorphism, no modals where inline/progressive works (the invite form, confirms, and channel add are inline cards/rows), no em dashes in copy.
