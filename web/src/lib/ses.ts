/**
 * Amazon SES's SMTP interface, shared by the two forms that point something at it: instance mail
 * (Settings > Mail) and a project's own SMTP config (the project SMTP tab). Both ask for a region
 * plus SES SMTP credentials and let the server derive the endpoint, so the region list and the
 * endpoint preview live here rather than in whichever form was written first.
 */

/** SES regions offered in the dropdowns. Convenience only — the server validates the region's SHAPE
 * rather than membership in a list, so a region AWS launches after this ships still works if it's
 * set through the API; keeping this current just saves the admin a lookup. */
export const SES_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'af-south-1',
  'me-south-1',
  'me-central-1',
  'il-central-1',
  'ap-south-1',
  'ap-south-2',
  'ap-east-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
];

export const SES_DEFAULT_REGION = 'us-east-1';

/** Mirrors `server/src/lib/ses.ts` — port 587 with STARTTLS. */
export const SES_SMTP_PORT = 587;

/** The endpoint a region resolves to, for the "this is what you'll connect to" line under the form.
 * Display only: the server derives the real value itself and never trusts a host from the client. */
export function sesSmtpHost(region: string): string {
  return `email-smtp.${region.trim()}.amazonaws.com`;
}
