/**
 * Shared UI primitives, built once from DESIGN.md v2 (the OpenShip-replica system) so every page
 * composes these instead of reinventing them: buttons, fields, toggles, cards with icon-squircle
 * headers, badges, status dots, tabs, skeletons, empty states.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { Link } from 'wouter';
import { Check, ChevronDown, Copy, GitBranch, LoaderCircle, Lock, Search, X } from 'lucide-react';

/** DESIGN.md iconography: lucide, strokeWidth 1.75, size 20 (18 in dense rows). */
export const ICON_STROKE = 1.75;

// ---------------------------------------------------------------------------
// Status dot — plain 8px dot, no glow (DESIGN.md, Status dots).
// ---------------------------------------------------------------------------

export type StatusDotStatus = 'ok' | 'warn' | 'danger' | 'idle';

const DOT_COLOR: Record<StatusDotStatus, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  idle: 'var(--border)',
};

const DOT_LABEL: Record<StatusDotStatus, string> = {
  ok: 'ok',
  warn: 'running',
  danger: 'failed',
  idle: 'idle',
};

export interface StatusDotProps {
  status: StatusDotStatus;
  /** Defaults to pulsing only for `warn` (running/queued), per DESIGN.md. */
  pulse?: boolean;
  label?: string;
  className?: string;
}

export function StatusDot({ status, pulse, label, className = '' }: StatusDotProps) {
  const shouldPulse = pulse ?? status === 'warn';

  return (
    <span
      role="img"
      aria-label={label ?? `status: ${DOT_LABEL[status]}`}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${shouldPulse ? 'dot-pulse' : ''} ${className}`}
      style={{ backgroundColor: DOT_COLOR[status] }}
    />
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'cta';
export type ButtonSize = 'md' | 'sm';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // Near-black in light / white in dark (DESIGN.md Buttons).
  primary: 'bg-primary text-primary-fg hover:opacity-90 active:opacity-80',
  secondary: 'bg-surface-2 text-ink hover:bg-surface-3 active:bg-surface-3/80',
  outline: 'border border-line bg-surface text-ink hover:bg-surface-2 active:bg-surface-3',
  // Destructive text: plain --danger label, no fill.
  danger: 'text-danger hover:bg-danger/10 active:bg-danger/15',
  // The one loud gradient (sidebar New Project); solid lime in dark via the `cta` utility.
  cta: 'cta rounded-full font-semibold hover:opacity-95 active:opacity-90',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  md: 'h-10 px-4 text-base',
  sm: 'h-8 px-3 text-sm',
};

/** One class string for anything that must look like a button (links included). */
export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', className = ''): string {
  return `inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45 ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]} ${className}`;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({ variant = 'primary', size = 'md', loading = false, disabled, className = '', children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
    >
      {loading && <LoaderCircle size={16} strokeWidth={2} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** A wouter Link dressed as a Button, for CTAs that navigate. */
export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  className = '',
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClasses(variant, size, className)}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Form controls — 44px, rounded-xl, focus ring (DESIGN.md Forms).
// ---------------------------------------------------------------------------

const FIELD_CLASSES =
  'h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-base text-ink placeholder:text-faint transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-soft';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Machine-ish values (domains, IPs, tokens, slugs) render in IBM Plex Mono per DESIGN.md. */
  mono?: boolean;
  /**
   * Declared explicitly because `InputHTMLAttributes` doesn't carry it. Under React 19 a ref is an
   * ordinary prop on a function component, so it needs no `forwardRef` — it just has to be part of
   * the type to be passed at all. Used where a page has to move focus into a field it doesn't own
   * (the Projects list's `/` shortcut, for one).
   */
  ref?: Ref<HTMLInputElement>;
}

export function Input({ mono = false, className = '', ...rest }: InputProps) {
  return <input {...rest} className={`${FIELD_CLASSES} ${mono ? 'font-mono text-sm' : ''} ${className}`} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export function Textarea({ mono = false, className = '', ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      className={`${FIELD_CLASSES} h-auto min-h-24 py-2.5 leading-relaxed ${mono ? 'font-mono text-sm' : ''} ${className}`}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Machine-ish values (branch names, repo full names) render in IBM Plex Mono per DESIGN.md. */
  mono?: boolean;
}

export function Select({ mono = false, className = '', children, ...rest }: SelectProps) {
  return (
    <span className="relative block w-full">
      <select {...rest} className={`${FIELD_CLASSES} appearance-none pr-9 ${mono ? 'font-mono text-sm' : ''} ${className}`}>
        {children}
      </select>
      <ChevronDown
        size={16}
        strokeWidth={ICON_STROKE}
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-icon"
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Combobox — searchable dropdown, replacing the browser's native <select> where
// the list can be long (branches, above all). A native select renders the OS's
// own list: no filtering, no styling, and unusable once a repo has a few dozen
// branches. This one is our own popover: a search field, keyboard navigation,
// and the full list scrolled in-place.
// ---------------------------------------------------------------------------

export interface ComboboxProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  /** Machine-ish values (branch names) render in IBM Plex Mono per DESIGN.md. */
  mono?: boolean;
  /** Rendered at the left of the trigger and of every row (a `GitBranch`, typically). */
  icon?: ReactNode;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Word for one row, used in the search placeholder and the empty state ("branch"). */
  noun?: string;
  /**
   * Lets the typed text be committed as the value even when it matches nothing in `options` — for
   * a remote whose listing is incomplete (or stale), where a hand-typed ref still deploys fine.
   */
  allowCustom?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Combobox({
  value,
  options,
  onChange,
  mono = false,
  icon,
  placeholder = 'Select…',
  searchPlaceholder,
  noun = 'option',
  allowCustom = false,
  disabled = false,
  id,
  className = '',
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const listId = `${id ?? generatedId}-list`;

  const trimmedQuery = query.trim();
  const matches = useMemo(() => {
    if (trimmedQuery === '') return options;
    const needle = trimmedQuery.toLowerCase();
    // Prefix matches first, then anything containing the query — typing "rel" should reach
    // `release/2.1` before `hotfix/prerelease`, which is what a branch search is usually after.
    const prefix: string[] = [];
    const rest: string[] = [];
    for (const option of options) {
      const haystack = option.toLowerCase();
      if (haystack.startsWith(needle)) prefix.push(option);
      else if (haystack.includes(needle)) rest.push(option);
    }
    return [...prefix, ...rest];
  }, [options, trimmedQuery]);

  // The typed text as its own row, offered only when it isn't already one of the matches.
  const customValue = allowCustom && trimmedQuery !== '' && !matches.includes(trimmedQuery) ? trimmedQuery : null;
  const rows = customValue === null ? matches : [...matches, customValue];

  // Every reopen and every keystroke lands the highlight on the row Enter should take: the current
  // value when the list is untouched, otherwise the best match at the top.
  useEffect(() => {
    if (!open) return;
    const selectedIndex = rows.indexOf(value);
    setActiveIndex(trimmedQuery === '' && selectedIndex >= 0 ? selectedIndex : 0);
    // `rows` is derived from the query, so keying off the query keeps this to one run per keystroke.
  }, [open, trimmedQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on an outside click or on Escape — the two ways a popover is expected to go away.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery('');
  }, [open]);

  // Keep the highlighted row in view while arrowing through a list taller than the panel.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  function commit(next: string) {
    onChange(next);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      if (open) {
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + delta + rows.length) % rows.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : rows.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const picked = rows[activeIndex];
      if (picked !== undefined) commit(picked);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  const monoClass = mono ? 'font-mono text-sm' : '';

  return (
    <div ref={rootRef} className={`relative ${className}`} onKeyDown={onKeyDown}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
        className={`${FIELD_CLASSES} flex items-center gap-2 pr-9 text-left ${open ? 'ring-2 ring-focus' : ''}`}
      >
        {icon && <span className="shrink-0 text-icon">{icon}</span>}
        <span className={`min-w-0 flex-1 truncate ${value === '' ? 'text-faint' : 'text-ink'} ${monoClass}`}>
          {value === '' ? placeholder : value}
        </span>
        <ChevronDown
          size={16}
          strokeWidth={ICON_STROKE}
          aria-hidden
          className={`pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-icon transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search size={15} strokeWidth={ICON_STROKE} aria-hidden className="shrink-0 text-icon" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder ?? `Search ${noun}s…`}
              aria-label={`Search ${noun}s`}
              aria-controls={listId}
              className="h-10 w-full bg-transparent text-sm text-ink placeholder:text-faint focus-visible:outline-none"
            />
            {query !== '' && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                className="shrink-0 rounded-md p-1 text-icon hover:bg-surface-2"
              >
                <X size={14} strokeWidth={ICON_STROKE} />
              </button>
            )}
          </div>

          <div ref={listRef} id={listId} role="listbox" className="max-h-64 overflow-y-auto p-1.5">
            {rows.length === 0 ? (
              <p className="px-2.5 py-6 text-center text-sm text-soft">No {noun} matches “{trimmedQuery}”.</p>
            ) : (
              rows.map((option, index) => {
                const selected = option === value;
                const active = index === activeIndex;
                return (
                  <button
                    key={option}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={active}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(option)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 ${
                      active ? 'bg-surface-2' : ''
                    }`}
                  >
                    {icon && <span className="shrink-0 text-icon">{icon}</span>}
                    <span className={`min-w-0 flex-1 truncate text-sm ${selected ? 'font-medium text-ink' : 'text-ink'} ${monoClass}`}>
                      {option}
                    </span>
                    {option === customValue && <span className="shrink-0 text-[12.5px] text-soft">Use this {noun}</span>}
                    {selected && <Check size={15} strokeWidth={2.25} aria-hidden className="shrink-0 text-ink" />}
                  </button>
                );
              })
            )}
          </div>

          {options.length > 0 && (
            <div className="border-t border-line px-3 py-2 text-[12.5px] text-soft">
              {trimmedQuery === ''
                ? `${options.length} ${noun}${options.length === 1 ? '' : 's'}`
                : `${matches.length} of ${options.length} ${noun}${options.length === 1 ? '' : 's'}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  /**
   * `div` for controls that aren't a single labelable element — a `Combobox`, whose trigger button
   * and popover (search field included) would otherwise be nested inside a `<label>`, where a click
   * anywhere in the field gets forwarded to the popover's input.
   */
  as?: 'label' | 'div';
  children: ReactNode;
}

/** Label (13.5px/500) above the control, helper/error line below (DESIGN.md Forms). */
export function Field({ label, hint, error, as: Wrapper = 'label', children }: FieldProps) {
  return (
    <Wrapper className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {error ? (
        <span className="text-[13px] text-danger">{error}</span>
      ) : hint ? (
        <span className="text-[13px] text-soft">{hint}</span>
      ) : null}
    </Wrapper>
  );
}

// ---------------------------------------------------------------------------
// Toggle — 44×24 pill; ON = near-black (dark: white), knob white (dark: black).
// ---------------------------------------------------------------------------

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
}

export function Toggle({ checked, onChange, disabled, className = '', ...rest }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={rest['aria-label']}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45 ${
        checked ? 'bg-primary' : 'bg-surface-3'
      } ${className}`}
    >
      <span
        aria-hidden
        className={`inline-block h-5 w-5 rounded-full shadow-sm transition-transform duration-150 ease-out ${
          checked ? 'translate-x-[22px] bg-primary-fg' : 'translate-x-0.5 bg-white'
        }`}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Checkbox — rounded-md box, primary fill when checked.
// ---------------------------------------------------------------------------

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, label, disabled, className = '' }: CheckboxProps) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2.5 ${disabled ? 'cursor-not-allowed opacity-45' : ''} ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-colors duration-150 ease-out peer-focus-visible:ring-2 peer-focus-visible:ring-focus ${
          checked ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface'
        }`}
      >
        {checked && <Check size={14} strokeWidth={2.5} />}
      </span>
      {label && <span className="text-base text-ink">{label}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Badge — pill, 12.5px/500 (DESIGN.md Badges/chips).
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'ok' | 'danger';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-soft',
  ok: 'bg-ok-tint text-ok-tint-fg',
  danger: 'bg-danger/10 text-danger',
};

export function Badge({ tone = 'neutral', className = '', children }: { tone?: BadgeTone; className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-medium ${BADGE_TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Icon chip — the 40px squircle behind section-header icons (DESIGN.md Iconography).
// ---------------------------------------------------------------------------

export type IconChipTone = 'neutral' | 'orange' | 'purple' | 'green' | 'danger';

const CHIP_TONES: Record<IconChipTone, string> = {
  neutral: 'bg-surface-2 text-icon',
  orange: 'bg-tint-orange text-tint-orange-fg',
  purple: 'bg-tint-purple text-tint-purple-fg',
  green: 'bg-tint-green text-tint-green-fg',
  // Same treatment `Badge`'s danger tone uses, so a destructive thing looks the same whichever
  // shape it is wearing. Used by the audit log to mark drops, deletes and failed sign-ins.
  danger: 'bg-danger/10 text-danger',
};

export function IconChip({
  tone = 'neutral',
  size = 40,
  className = '',
  children,
}: {
  tone?: IconChipTone;
  /** Box size in px; 40 for card headers, 36 for dense rows. */
  size?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-xl ${CHIP_TONES[tone]} ${className}`}
      style={{ width: size, height: size }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Card + CardHeader (DESIGN.md Cards).
// ---------------------------------------------------------------------------

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-2xl border border-line bg-surface p-6 ${className}`}>{children}</div>;
}

export interface CardHeaderProps {
  /** A lucide icon element (size 20, strokeWidth ICON_STROKE); rendered inside a 40px squircle. */
  icon?: ReactNode;
  iconTone?: IconChipTone;
  title: string;
  description?: string;
  /** Action slot, top-right (e.g. "+ Add", "Invite member"). */
  action?: ReactNode;
  className?: string;
}

export function CardHeader({ icon, iconTone = 'neutral', title, description, action, className = '' }: CardHeaderProps) {
  return (
    <div className={`flex items-start gap-3.5 ${className}`}>
      {icon && <IconChip tone={iconTone}>{icon}</IconChip>}
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-soft">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avatar — initial-letter circle (DESIGN.md App shell, account card).
// ---------------------------------------------------------------------------

export function Avatar({ name, size = 36, className = '' }: { name: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full bg-surface-3 font-semibold text-ink ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page scaffolding
// ---------------------------------------------------------------------------

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Right-aligned slot: kebab icon button, primary action, etc. */
  actions?: ReactNode;
}

/** Title 28px/600 + subtitle line under it (DESIGN.md Page header). */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="mb-8 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-3xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-lg text-soft">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** 11px/600 uppercase section label (DESIGN.md Typography). */
export function SectionLabel({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`section-label ${className}`}>{children}</div>;
}

/**
 * Content grid with the optional fixed 380px right rail (DESIGN.md App shell).
 * Collapses to one column below 1200px.
 */
export function PageWithRail({ children, rail, className = '' }: { children: ReactNode; rail: ReactNode; className?: string }) {
  return (
    <div className={`grid grid-cols-1 items-start gap-5 min-[1200px]:grid-cols-[minmax(0,1fr)_380px] ${className}`}>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
      <div className="flex min-w-0 flex-col gap-5">{rail}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs — pill tabs with count pills (DESIGN.md Notifications matrix / Audit log).
// ---------------------------------------------------------------------------

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, value, onChange, className = '' }: TabsProps) {
  return (
    <div role="tablist" className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={`inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-base font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              active ? 'bg-surface-3 text-ink' : 'text-soft hover:bg-surface-2 hover:text-ink'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium ${
                  active ? 'bg-surface text-soft' : 'bg-surface-2 text-soft'
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading / empty states
// ---------------------------------------------------------------------------

/** Surface-tint shimmer block. Used for loading lists — never a centered spinner. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-lg ${className}`} aria-hidden />;
}

/** Full-page skeleton mirroring the v2 shell (floating sidebar card + content column). */
export function ShellSkeleton() {
  return (
    <div className="flex min-h-screen bg-page">
      <div className="m-3 hidden w-[280px] shrink-0 flex-col gap-6 rounded-[20px] border border-line bg-surface p-4 min-[900px]:flex">
        <Skeleton className="h-8 w-32" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
      <div className="flex-1 px-10 py-8">
        <Skeleton className="mb-6 h-8 w-48" />
        <Skeleton className="h-36 w-full max-w-3xl rounded-2xl" />
        <Skeleton className="mt-4 h-36 w-full max-w-3xl rounded-2xl" />
      </div>
    </div>
  );
}

export interface EmptyStateAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface EmptyStateProps {
  /** Headline, 22px/600. Optional for old call sites that only pass `message`. */
  title?: string;
  /** The one/two-line explainer under the headline, 15px soft. */
  message: string;
  /** Primary CTA. */
  action?: EmptyStateAction;
  /** Optional second, quieter CTA (outline). */
  secondaryAction?: EmptyStateAction;
  /** Optional monochrome illustration slot above the headline. */
  icon?: ReactNode;
  className?: string;
}

function EmptyStateButton({ action, variant }: { action: EmptyStateAction; variant: ButtonVariant }) {
  return action.href ? (
    <ButtonLink href={action.href} variant={variant}>
      {action.label}
    </ButtonLink>
  ) : (
    <Button variant={variant} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

/** Centered headline + explainer + CTA pair (DESIGN.md Empty states). */
export function EmptyState({ title, message, action, secondaryAction, icon, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface px-8 py-14 text-center ${className}`}>
      {icon && <div className="mb-3 text-icon">{icon}</div>}
      {title && <h2 className="text-2xl font-semibold text-ink">{title}</h2>}
      <p className="max-w-md text-lg text-soft">{message}</p>
      {(action || secondaryAction) && (
        <div className="mt-4 flex items-center gap-2.5">
          {action && <EmptyStateButton action={action} variant="primary" />}
          {secondaryAction && <EmptyStateButton action={secondaryAction} variant="outline" />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline chips (mono values) — kept from v1, restyled to v2 surfaces.
// ---------------------------------------------------------------------------

/** A mono chip for inline machine-ish values: slugs, SHAs, ports. */
/**
 * The branch a deployment built from, as shown in both deployment tables.
 *
 * `null` renders an em dash rather than falling back to the project's current branch: a row from
 * before the column existed, or a rollback to a release that can't be attributed, genuinely doesn't
 * know — and guessing there would make the column untrustworthy for every row that does know.
 */
export function BranchLabel({ branch, className = '' }: { branch: string | null; className?: string }) {
  if (branch === null) {
    return <span className={`text-sm text-faint ${className}`}>&mdash;</span>;
  }
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} title={branch}>
      <GitBranch size={13} strokeWidth={ICON_STROKE} aria-hidden className="shrink-0 text-icon" />
      <span className="truncate font-mono text-xs text-soft">{branch}</span>
    </span>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-soft">{children}</span>;
}

// ---------------------------------------------------------------------------
// Copy row — a labelled value with a copy button (database credentials, service info).
// ---------------------------------------------------------------------------

/**
 * One `label: value` line on a `--surface` tile, with a copy button that confirms for 1.5s. A
 * `multiline` value keeps its line breaks on screen (an `.env` block); anything else is a single
 * truncated line.
 */
/**
 * Clipboard write plus a 1.5s "copied" flag, shared by both copy affordances. A failed write is
 * swallowed on purpose: the Clipboard API is unavailable over plain http and can be denied outright,
 * and in either case the value is still on screen to copy by hand — an error toast would add nothing.
 */
function useCopyAction(value: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);

  return {
    copied,
    copy: () => {
      void navigator.clipboard
        .writeText(value)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {});
    },
  };
}

/** Icon-only copy button, for a value that already reads as itself (a domain, an IP). */
export function CopyIconButton({ value, label, className = '' }: { value: string; label: string; className?: string }) {
  const { copied, copy } = useCopyAction(value);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-icon transition-colors duration-150 ease-out hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
    >
      {copied ? <Check size={15} strokeWidth={2.25} aria-hidden /> : <Copy size={15} strokeWidth={ICON_STROKE} aria-hidden />}
    </button>
  );
}

export function CopyRow({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const { copied, copy } = useCopyAction(value);

  return (
    <div className={`flex justify-between gap-3 rounded-lg bg-surface px-3 py-2.5 ${multiline ? 'items-start' : 'items-center'}`}>
      <div className="min-w-0">
        <p className="text-xs text-soft">{label}</p>
        {multiline ? (
          <pre className="mt-0.5 overflow-x-auto font-mono text-sm text-ink">{value}</pre>
        ) : (
          <p className="truncate font-mono text-sm text-ink">{value}</p>
        )}
      </div>
      <button
        type="button"
        onClick={copy}
        className="inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-soft transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {copied ? <Check size={14} strokeWidth={ICON_STROKE} aria-hidden /> : <Copy size={14} strokeWidth={ICON_STROKE} aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReadOnlyNotice — why a settings section's controls are inert for this viewer.
// ---------------------------------------------------------------------------

/**
 * The one line every Settings section shows a member in place of its Save button. Members can SEE
 * every section (that is the product decision — the instance's configuration is not a secret from
 * the people deploying on it) but can change nothing, and the server enforces that independently:
 * every settings write is admin-gated in `server/src/routes/*`, so this notice explains a boundary
 * rather than creating one.
 *
 * It exists because the alternative — leaving the inputs live and letting Save return 403 — teaches
 * someone the rule only by failing at them, after they have typed. Disabling the controls and
 * saying why up front is the same information delivered before the work instead of after it.
 *
 * `can` is the whole predicate, not just a noun — "change mail settings", "delete this project" —
 * so the sentence reads specifically on each page AND stays grammatical for the sections whose
 * restricted action isn't a change at all.
 */
export function ReadOnlyNotice({ can = 'change these settings' }: { can?: string }) {
  return (
    <p className="flex items-center gap-2 text-[13px] text-soft">
      <Lock size={14} strokeWidth={ICON_STROKE} aria-hidden className="shrink-0 text-icon" />
      Only admins can {can}.
    </p>
  );
}
