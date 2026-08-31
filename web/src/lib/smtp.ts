/**
 * The email services a project's mail can go through, as offered in both places that ask: the
 * project SMTP tab and the New Project form. One list, because the two are answering the same
 * question and a project picking "Amazon SES" at creation must mean exactly what picking it later
 * means.
 *
 * What each choice actually WRITES lives in `server/src/deploy/envfile.ts`'s `buildManagedVars`,
 * which both surfaces call directly rather than restating — see `managedMailVars` below.
 */
import { buildManagedVars, type SesSmtpConfig, type SmtpConfig } from '../../../server/src/deploy/envfile.js';
import type { ProjectSmtpMode } from '../api';

export interface SmtpOption {
  value: ProjectSmtpMode;
  label: string;
  blurb: string;
}

export const SMTP_OPTIONS: SmtpOption[] = [
  { value: 'mailpit', label: 'Mailpit', blurb: 'Local catch-all. Nothing leaves the server.' },
  { value: 'custom', label: 'Custom', blurb: 'Your own SMTP server.' },
  { value: 'ses', label: 'Amazon SES', blurb: "Send through Amazon SES using your region's SMTP credentials." },
  { value: 'none', label: 'None', blurb: 'Mail sending is disabled.' },
];

export function smtpOptionLabel(mode: ProjectSmtpMode): string {
  return SMTP_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

/**
 * The `MAIL_*` block the selected service will contribute to the project's `.env`, or `null` while
 * the form still lacks something it needs (`buildManagedVars` throws on an incomplete custom/SES
 * config rather than inventing a host — see its doc comment). `null` means "nothing to preview
 * yet", never "this service writes nothing": `none` legitimately returns an empty object.
 *
 * Calling the server's own builder rather than reproducing it is the point. A preview that merely
 * looked like the real block would be free to disagree with it, and the whole reason this is shown
 * at creation time is so the user can trust what they are about to get.
 */
export function managedMailVars(
  mode: ProjectSmtpMode,
  config: { smtpConfig?: SmtpConfig; sesConfig?: SesSmtpConfig },
): Record<string, string> | null {
  try {
    return buildManagedVars({ smtpMode: mode, ...config });
  } catch {
    return null;
  }
}
