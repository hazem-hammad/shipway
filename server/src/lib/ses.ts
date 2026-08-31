/**
 * Amazon SES's SMTP interface, shared by the two places Shipway points something at it: instance
 * mail (`services/mailer.ts`, Settings > Mail) and a project's own SMTP config
 * (`deploy/envfile.ts`, the project SMTP tab).
 *
 * Both work the same way — an admin supplies a region plus SES SMTP credentials, and the endpoint is
 * DERIVED rather than typed — so the derivation and its validation live here rather than being
 * written twice. Pure: no db, no network, no imports, so `deploy/envfile.ts` can use it without
 * pulling the mailer's nodemailer/db dependencies into the deploy path.
 */

/**
 * SES exposes a plain SMTP endpoint per region (`email-smtp.<region>.amazonaws.com`). Port 587
 * (STARTTLS) rather than 465 (implicit TLS) because 587 is the port most reliably left open for
 * outbound mail by hosting providers; SES accepts both.
 */
export const SES_SMTP_PORT = 587;

/** The `MAIL_ENCRYPTION` value a framework needs for port 587's STARTTLS upgrade. */
export const SES_SMTP_ENCRYPTION = 'tls';

/** AWS region-code shape (`us-east-1`, `ap-southeast-2`, `eu-central-2`, `us-gov-west-1`). This is a
 * SECURITY check, not a nicety: the region is interpolated straight into the SMTP hostname, so
 * anything not matching this is rejected rather than allowed to redirect mail — credentials and all
 * — at an attacker-chosen host. Deliberately a shape check and not an allowlist of today's SES
 * regions, so a newly launched region works without a Shipway release. */
const SES_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;

/** Whether `region` is a well-formed AWS region code — the guard every path that builds an SES
 * hostname goes through. */
export function isValidSesRegion(region: string | undefined): region is string {
  return typeof region === 'string' && SES_REGION_PATTERN.test(region);
}

/** The SES SMTP endpoint for `region`. Only ever call this with a region `isValidSesRegion` accepts. */
export function sesSmtpHost(region: string): string {
  return `email-smtp.${region}.amazonaws.com`;
}
