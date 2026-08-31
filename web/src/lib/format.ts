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

/** Formats a millisecond duration as "1m 42s" / "8s", for deployment durations. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(seconds)}s`;
}

// ---------------------------------------------------------------------------
// Absolute time — for records where "3 days ago" is not an answer.
//
// A deploy list can live on relative time: what matters there is recency. An audit log cannot —
// the question it exists to answer is "what happened at 14:32 on Tuesday", so it needs the wall
// clock, and it needs it in the reader's own timezone (every formatter below is local, matching
// the epoch-ms-everywhere convention in db/schema.ts).
// ---------------------------------------------------------------------------

const timeOfDayFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayHeadingFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const dayHeadingWithYearFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const timestampFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** `14:32` — the time an entry was recorded, local, 24-hour. */
export function formatTimeOfDay(epochMs: number): string {
  return timeOfDayFormat.format(epochMs);
}

/** The full local timestamp to the second, for a `title` attribute — the exact value behind a
 * rounded one, available on hover without spending a column on it. */
export function formatTimestamp(epochMs: number): string {
  return timestampFormat.format(epochMs);
}

/**
 * A stable local-day key (`2026-08-26`) for grouping entries into days.
 *
 * Built from the local date parts rather than `toISOString().slice(0, 10)`, which is UTC: east of
 * Greenwich that puts the late evening into tomorrow's group, and west of it puts the early morning
 * into yesterday's — a bug that only ever shows up for readers in another timezone.
 */
export function dayKey(epochMs: number): string {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/** `Today` / `Yesterday` / `Monday, 24 August` / `24 August 2025` once the year differs. */
export function formatDayHeading(epochMs: number): string {
  const key = dayKey(epochMs);
  const now = Date.now();
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now - 86_400_000)) return 'Yesterday';
  return new Date(epochMs).getFullYear() === new Date(now).getFullYear()
    ? dayHeadingFormat.format(epochMs)
    : dayHeadingWithYearFormat.format(epochMs);
}
