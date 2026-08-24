/**
 * Shared UI primitives, built once from DESIGN.md v2 (the OpenShip-replica system) so every page
 * composes these instead of reinventing them: buttons, fields, toggles, cards with icon-squircle
 * headers, badges, status dots, tabs, skeletons, empty states.
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { Link } from 'wouter';
import { Check, ChevronDown, LoaderCircle } from 'lucide-react';

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

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

/** Label (13.5px/500) above the control, helper/error line below (DESIGN.md Forms). */
export function Field({ label, hint, error, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {error ? (
        <span className="text-[13px] text-danger">{error}</span>
      ) : hint ? (
        <span className="text-[13px] text-soft">{hint}</span>
      ) : null}
    </label>
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

export type IconChipTone = 'neutral' | 'orange' | 'purple' | 'green';

const CHIP_TONES: Record<IconChipTone, string> = {
  neutral: 'bg-surface-2 text-icon',
  orange: 'bg-tint-orange text-tint-orange-fg',
  purple: 'bg-tint-purple text-tint-purple-fg',
  green: 'bg-tint-green text-tint-green-fg',
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
export function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-soft">{children}</span>;
}
