/**
 * Shared UI primitives, built once from DESIGN.md so every later page composes these instead of
 * reinventing them: tokens, buttons, inputs, skeletons, empty states, the berth light, and the
 * setup wizard's progress rail.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { Link } from 'wouter';

// ---------------------------------------------------------------------------
// Berth light — the product's one recurring identity mark (DESIGN.md, Signature).
// ---------------------------------------------------------------------------

export type BerthStatus = 'go' | 'stop' | 'hold' | 'unknown';

const STATUS_VAR: Record<BerthStatus, string> = {
  go: '--color-go',
  stop: '--color-stop',
  hold: '--color-hold',
  unknown: '--color-ink-soft',
};

const STATUS_LABEL: Record<BerthStatus, string> = {
  go: 'success',
  stop: 'failed',
  hold: 'running',
  unknown: 'unknown',
};

export interface BerthLightProps {
  status: BerthStatus;
  /** Defaults to pulsing only for `hold` (running/queued), per DESIGN.md. */
  pulse?: boolean;
  label?: string;
  className?: string;
}

/** An 8px round lamp with a 3px soft glow of the same color at 25% alpha. */
export function BerthLight({ status, pulse, label, className = '' }: BerthLightProps) {
  const colorVar = STATUS_VAR[status];
  const shouldPulse = pulse ?? status === 'hold';

  return (
    <span
      role="img"
      aria-label={label ?? `status: ${STATUS_LABEL[status]}`}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${shouldPulse ? 'berth-pulse' : ''} ${className}`}
      style={{
        backgroundColor: `var(${colorVar})`,
        boxShadow: `0 0 0 3px color-mix(in oklch, var(${colorVar}) 25%, transparent)`,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'destructive';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-paper hover:bg-accent/90 active:bg-accent/80 disabled:bg-accent/40',
  secondary:
    'border border-line bg-paper text-ink hover:bg-panel active:bg-panel/70 disabled:text-ink-soft disabled:hover:bg-paper',
  destructive: 'bg-stop text-paper hover:bg-stop/90 active:bg-stop/80 disabled:bg-stop/40',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

export function Button({ variant = 'primary', loading = false, disabled, className = '', children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {loading && (
        <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const FIELD_CLASSES =
  'w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft transition-colors duration-150 ease-out hover:border-ink-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent disabled:cursor-not-allowed disabled:bg-panel disabled:text-ink-soft';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Machine-ish values (domains, IPs, tokens, slugs) render in IBM Plex Mono per DESIGN.md. */
  mono?: boolean;
}

export function Input({ mono = false, className = '', ...rest }: InputProps) {
  return <input {...rest} className={`${FIELD_CLASSES} ${mono ? 'font-mono' : ''} ${className}`} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export function Textarea({ mono = false, className = '', ...rest }: TextareaProps) {
  return <textarea {...rest} className={`${FIELD_CLASSES} ${mono ? 'font-mono' : ''} ${className}`} />;
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

/** Label + control + hint/error line. Wraps the control in a `<label>` for implicit association. */
export function Field({ label, hint, error, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {error ? <span className="text-xs text-stop">{error}</span> : hint ? <span className="text-xs text-ink-soft">{hint}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Loading / empty states
// ---------------------------------------------------------------------------

/** Panel-tint shimmer block. Used for loading lists — never a centered spinner. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} aria-hidden />;
}

/** Full-page skeleton shell shown while setup/auth status is still resolving. */
export function ShellSkeleton() {
  return (
    <div className="flex min-h-screen bg-paper">
      <div className="hidden w-[220px] shrink-0 flex-col gap-6 border-r border-line bg-panel p-4 min-[900px]:flex">
        <Skeleton className="h-5 w-24" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
      <div className="flex-1 p-8">
        <Skeleton className="mb-6 h-6 w-40" />
        <Skeleton className="h-10 w-full max-w-2xl" />
        <Skeleton className="mt-2 h-10 w-full max-w-2xl" />
        <Skeleton className="mt-2 h-10 w-full max-w-2xl" />
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
  message: string;
  action?: EmptyStateAction;
  className?: string;
}

/** One sentence + one action. No feature theater (PRODUCT.md, strategic principle 5). */
export function EmptyState({ message, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-start gap-3 rounded-lg border border-dashed border-line bg-panel/50 px-6 py-10 ${className}`}>
      <p className="text-sm text-ink-soft">{message}</p>
      {action &&
        (action.href ? (
          <Link
            href={action.href}
            className="inline-flex items-center justify-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-paper transition-colors duration-150 ease-out hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            {action.label}
          </Link>
        ) : (
          <Button onClick={action.onClick}>{action.label}</Button>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-between gap-4">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-line bg-paper p-6 ${className}`}>{children}</div>;
}

/** A mono chip for inline machine-ish values: slugs, SHAs, ports. */
export function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded bg-panel px-1.5 py-0.5 font-mono text-xs text-ink-soft">{children}</span>;
}

// ---------------------------------------------------------------------------
// Progress rail — the setup wizard's berth-light stepper (DESIGN.md, Signature).
// ---------------------------------------------------------------------------

export interface ProgressRailProps {
  steps: string[];
  /** 0-based index of the step currently active. Earlier steps render as done (green). */
  currentIndex: number;
}

export function ProgressRail({ steps, currentIndex }: ProgressRailProps) {
  return (
    <ol className="mb-8 flex items-center">
      {steps.map((label, index) => {
        const status: BerthStatus = index < currentIndex ? 'go' : index === currentIndex ? 'hold' : 'unknown';
        const reached = index <= currentIndex;
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none">
            <span className="flex items-center gap-2">
              <BerthLight status={status} />
              <span className={`text-xs font-medium whitespace-nowrap ${reached ? 'text-ink' : 'text-ink-soft'}`}>{label}</span>
            </span>
            {index < steps.length - 1 && <span className="mx-3 h-px flex-1 bg-line" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
