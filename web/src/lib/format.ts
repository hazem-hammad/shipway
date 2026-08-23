/** First 7 characters of a commit SHA — the conventional short form, shown in mono chips. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

const relativeTimeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** Formats an epoch-ms timestamp as "3 minutes ago" / "in 2 hours", for deploy timestamps. */
export function formatRelativeTime(epochMs: number): string {
  const diffSeconds = Math.round((epochMs - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);

  for (const [unit, secondsInUnit] of RELATIVE_UNITS) {
    if (absSeconds >= secondsInUnit) {
      return relativeTimeFormat.format(Math.round(diffSeconds / secondsInUnit), unit);
    }
  }
  return relativeTimeFormat.format(diffSeconds, 'second');
}
