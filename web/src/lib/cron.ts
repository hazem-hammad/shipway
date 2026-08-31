/**
 * Reading and writing cron expressions for the project Cron tab: validation (a mirror of the
 * server's `validateCronExpr`), a plain-English description, next-run times, and the translation
 * between an expression and the schedule builder's controls.
 *
 * Everything here is pure and works in WALL-CLOCK terms — `{year, month, day, hour, minute}` in the
 * HOST's timezone, which `GET /api/projects/:id/cron` reports. That's deliberate: cron fires on the
 * server's clock, so computing next-run times as instants in the viewer's browser timezone would
 * show the wrong time to anyone sitting in a different one. By never converting between zones — the
 * current host wall clock goes in, wall-clock times come out, and they're rendered as typed — there
 * is no conversion left to get wrong. DST transitions are the known limit of that simplification;
 * this is a preview of the schedule, not the scheduler.
 */

/** A local date/time with no timezone attached. `month` is 1-12 and `day` is 1-31, matching how cron
 * itself numbers them rather than JavaScript's 0-indexed months. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Aliases the server accepts in place of the 5-field form (`services/cron.ts`'s `CRON_ALIASES`),
 * mapped to their equivalents. `@reboot` has no clock equivalent and is handled separately. */
const ALIAS_EXPANSIONS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const REBOOT = '@reboot';

interface FieldRange {
  min: number;
  max: number;
}

/** minute, hour, day-of-month, month, day-of-week — in field order, matching the server. */
const FIELD_RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
];

/** One comma-separated cron token: `*`, `N`, `N-M`, or any of those with a trailing `/step`. */
const TOKEN_RE = /^(\*|\d+(?:-\d+)?)(\/(\d+))?$/;

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  /** Normalized to 0-6, with cron's `7` folded onto Sunday. */
  daysOfWeek: number[];
  /** Whether the day-of-month field was narrowed from `*`. Cron's day matching depends on this: see
   * `dayMatches`. */
  dayOfMonthRestricted: boolean;
  /** Whether the day-of-week field was narrowed from `*`. */
  dayOfWeekRestricted: boolean;
  /** `true` for `@reboot`, which runs at boot and has no clock schedule at all. */
  reboot: boolean;
}

/** Expands one field into the sorted list of values it matches, or `null` if malformed. */
function expandField(field: string, range: FieldRange): number[] | null {
  const values = new Set<number>();

  for (const token of field.split(',')) {
    const match = TOKEN_RE.exec(token);
    if (!match) return null;

    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (step < 1) return null;

    const base = match[1] as string;
    let lo: number;
    let hi: number;

    if (base === '*') {
      lo = range.min;
      hi = range.max;
    } else if (base.includes('-')) {
      const [loStr, hiStr] = base.split('-') as [string, string];
      lo = Number(loStr);
      hi = Number(hiStr);
      if (!inRange(lo, range) || !inRange(hi, range) || lo > hi) return null;
    } else {
      lo = Number(base);
      if (!inRange(lo, range)) return null;
      // A bare value with a step counts from that value to the end of the range (`5/10` in the
      // minute field is 5, 15, 25...), which is what cron does.
      hi = step > 1 ? range.max : lo;
    }

    for (let value = lo; value <= hi; value += step) values.add(value);
  }

  return [...values].sort((a, b) => a - b);
}

function inRange(n: number, range: FieldRange): boolean {
  return Number.isInteger(n) && n >= range.min && n <= range.max;
}

/** Parses `expr` into the values each field matches, or `null` when it isn't a valid expression.
 * Accepts exactly what the server accepts, so the form never reports valid for something the API
 * will then reject. */
export function parseCron(expr: string): ParsedCron | null {
  const trimmed = expr.trim();

  if (trimmed === REBOOT) {
    return { minutes: [], hours: [], daysOfMonth: [], months: [], daysOfWeek: [], dayOfMonthRestricted: false, dayOfWeekRestricted: false, reboot: true };
  }

  const expanded = ALIAS_EXPANSIONS[trimmed] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) return null;

  const parsedFields = fields.map((field, i) => expandField(field, FIELD_RANGES[i] as FieldRange));
  if (parsedFields.some((values) => values === null || values.length === 0)) return null;

  const [minutes, hours, daysOfMonth, months, rawWeekdays] = parsedFields as number[][];

  // Cron numbers Sunday as both 0 and 7; fold them together so downstream code has one Sunday.
  const daysOfWeek = [...new Set((rawWeekdays as number[]).map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);

  return {
    minutes: minutes as number[],
    hours: hours as number[],
    daysOfMonth: daysOfMonth as number[],
    months: months as number[],
    daysOfWeek,
    dayOfMonthRestricted: (fields[2] as string) !== '*',
    dayOfWeekRestricted: (fields[4] as string) !== '*',
    reboot: false,
  };
}

/** Whether `expr` is one the server will accept. */
export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `14:05`, in the 24-hour form the schedule fields themselves use. */
export function formatTime(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** `1st`, `2nd`, `23rd` — for "on the 23rd of the month". */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${String(n)}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${String(n)}${suffix}`;
}

/** `a, b and c` — the list separator used throughout the descriptions. */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
}

/** Whether `values` is exactly `range.min, range.min + step, ...` covering the whole range — i.e.
 * whether it came from a star-slash-step field. Returns the step, or `null` when the values aren't a clean
 * interval. This is what lets "every 5 minutes" be said instead of listing twelve minute values. */
function evenStep(values: number[], range: FieldRange): number | null {
  if (values.length < 2 || values[0] !== range.min) return null;
  const step = (values[1] as number) - (values[0] as number);
  if (step < 1) return null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== range.min + i * step) return null;
  }
  // The interval must actually run out the range, or it's a partial list that happens to be even.
  if (range.min + values.length * step <= range.max) return null;
  return step;
}

function isFull(values: number[], range: FieldRange): boolean {
  return values.length === range.max - range.min + 1;
}

/** The day-of-week/day-of-month clause, or `''` when the schedule runs every day. */
function describeDays(parsed: ParsedCron): string {
  const parts: string[] = [];

  if (parsed.dayOfWeekRestricted) {
    const names = parsed.daysOfWeek.map((d) => WEEKDAY_NAMES[d] as string);
    parts.push(parsed.daysOfWeek.length === 1 ? `on ${names[0] as string}` : `on ${joinList(names)}`);
  }
  if (parsed.dayOfMonthRestricted) {
    const days = parsed.daysOfMonth.map(ordinal);
    parts.push(`on the ${joinList(days)}`);
  }

  // When BOTH are restricted, cron runs on either — worth saying explicitly, because reading it as
  // "and" is the single most common cron misunderstanding.
  return parts.length === 2 ? `${parts[0] as string} or ${(parts[1] as string).replace(/^on /, '')}` : (parts[0] ?? '');
}

function describeMonths(parsed: ParsedCron): string {
  if (isFull(parsed.months, FIELD_RANGES[3] as FieldRange)) return '';
  return `in ${joinList(parsed.months.map((m) => MONTH_NAMES[m - 1] as string))}`;
}

/**
 * A plain-English rendering of `expr`, e.g. `Every 5 minutes`, `Every day at 03:00`,
 * `Every Monday at 09:30`. Returns `null` for an expression that isn't valid.
 *
 * Common shapes get a purpose-written sentence; anything else falls through to a composed one
 * ("At 09:00 and 17:00 on Monday") rather than giving up, so no valid expression is ever left
 * displayed as raw fields with no explanation.
 */
export function describeCron(expr: string): string | null {
  const parsed = parseCron(expr);
  if (!parsed) return null;
  if (parsed.reboot) return 'At server boot';

  const minuteRange = FIELD_RANGES[0] as FieldRange;
  const hourRange = FIELD_RANGES[1] as FieldRange;

  const everyMinute = isFull(parsed.minutes, minuteRange);
  const everyHour = isFull(parsed.hours, hourRange);
  const days = describeDays(parsed);
  const months = describeMonths(parsed);
  const suffix = [days, months].filter((part) => part !== '').join(' ');
  const withSuffix = (head: string): string => (suffix === '' ? head : `${head} ${suffix}`);

  // Every minute, and every N minutes.
  if (everyMinute && everyHour) return withSuffix('Every minute');
  const minuteStep = evenStep(parsed.minutes, minuteRange);
  if (minuteStep !== null && everyHour) return withSuffix(`Every ${String(minuteStep)} minutes`);

  // Hourly shapes: a fixed minute past every hour, or past every Nth hour.
  if (parsed.minutes.length === 1 && everyHour) {
    return withSuffix(`Every hour at :${pad2(parsed.minutes[0] as number)}`);
  }
  const hourStep = evenStep(parsed.hours, hourRange);
  if (parsed.minutes.length === 1 && hourStep !== null) {
    return withSuffix(`Every ${String(hourStep)} hours at :${pad2(parsed.minutes[0] as number)}`);
  }

  // A single time of day — the most common shape after "every N minutes".
  if (parsed.minutes.length === 1 && parsed.hours.length === 1) {
    const time = formatTime(parsed.hours[0] as number, parsed.minutes[0] as number);
    if (suffix === '') return `Every day at ${time}`;
    return `At ${time} ${suffix}`;
  }

  // Composed fallback: a handful of explicit times.
  const times = parsed.hours.flatMap((hour) => parsed.minutes.map((minute) => formatTime(hour, minute)));
  const timeList = times.length <= 4 ? joinList(times) : `${times.length.toString()} times a day`;
  return withSuffix(`At ${timeList}`);
}

// ---------------------------------------------------------------------------
// Next runs
// ---------------------------------------------------------------------------

/** Day of week (0 = Sunday) for a calendar date. Computed through a UTC instant deliberately: the
 * weekday of a given year/month/day is the same everywhere, and going through UTC keeps the local
 * timezone from shifting the date underneath us. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Whether a date matches the schedule's day fields, implementing cron's genuinely odd rule: when
 * BOTH day-of-month and day-of-week are restricted, a date matching EITHER one runs. When only one
 * is restricted, that one must match. (Vixie cron's behavior, and the reason `0 0 13 * 5` means
 * "the 13th, and every Friday" rather than "Friday the 13th".)
 */
function dayMatches(parsed: ParsedCron, year: number, month: number, day: number): boolean {
  if (!parsed.months.includes(month)) return false;

  const domHit = parsed.daysOfMonth.includes(day);
  const dowHit = parsed.daysOfWeek.includes(weekdayOf(year, month, day));

  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) return domHit || dowHit;
  if (parsed.dayOfMonthRestricted) return domHit;
  if (parsed.dayOfWeekRestricted) return dowHit;
  return true;
}

/** How far ahead `nextRuns` will look before giving up. Five years covers even a once-a-year
 * schedule landing on a date that only exists in leap years. */
const MAX_LOOKAHEAD_DAYS = 366 * 5;

/**
 * The next `count` times `expr` will run, at or after `from` (exclusive), as wall-clock times in
 * the same timezone `from` is expressed in. Returns `[]` for an invalid expression and for
 * `@reboot`, which has no next time to predict.
 *
 * Walks day by day rather than minute by minute: most candidate days fail the cheap `dayMatches`
 * check outright, so even a "once a year on a leap day" schedule resolves in a few thousand
 * comparisons instead of millions.
 */
export function nextRuns(expr: string, from: WallClock, count: number): WallClock[] {
  const parsed = parseCron(expr);
  if (!parsed || parsed.reboot || count <= 0) return [];

  const results: WallClock[] = [];
  let { year, month, day } = from;

  for (let elapsed = 0; elapsed < MAX_LOOKAHEAD_DAYS && results.length < count; elapsed++) {
    if (dayMatches(parsed, year, month, day)) {
      const isFirstDay = elapsed === 0;
      for (const hour of parsed.hours) {
        if (isFirstDay && hour < from.hour) continue;
        for (const minute of parsed.minutes) {
          // Strictly after `from`: "next run" never means "the minute you are looking at it".
          if (isFirstDay && hour === from.hour && minute <= from.minute) continue;
          results.push({ year, month, day, hour, minute });
          if (results.length === count) return results;
        }
      }
    }

    day += 1;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }

  return results;
}

/** The current wall clock in `timezone` (an IANA name). Falls back to the browser's own clock if
 * the zone isn't one this browser knows, which beats throwing inside a render. */
export function nowInTimezone(timezone: string, now: Date = new Date()): WallClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
  } catch {
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), minute: now.getMinutes() };
  }

  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // `hour12: false` still yields "24" for midnight in some engines; fold it back to 0.
  const hour = value('hour') % 24;
  return { year: value('year'), month: value('month'), day: value('day'), hour, minute: value('minute') };
}

/** `Today at 14:30`, `Tomorrow at 03:00`, or `Mon 1 Sep at 03:00` — relative for the two days a
 * reader can hold in their head, absolute beyond that. */
export function formatWallClock(when: WallClock, today: WallClock): string {
  const time = formatTime(when.hour, when.minute);
  const dayNumber = (w: WallClock): number => w.year * 10000 + w.month * 100 + w.day;
  const delta = dayNumber(when) - dayNumber(today);

  if (delta === 0) return `Today at ${time}`;
  // Not arithmetic on the number: 20260831 -> 20260901 is +70, not +1. Compare against the real
  // next calendar day instead.
  const tomorrow = addDay(today);
  if (dayNumber(when) === dayNumber(tomorrow)) return `Tomorrow at ${time}`;

  const weekday = WEEKDAY_SHORT[weekdayOf(when.year, when.month, when.day)] as string;
  const monthName = (MONTH_NAMES[when.month - 1] as string).slice(0, 3);
  return `${weekday} ${String(when.day)} ${monthName} at ${time}`;
}

function addDay(w: WallClock): WallClock {
  let { year, month, day } = w;
  day += 1;
  if (day > daysInMonth(year, month)) {
    day = 1;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return { year, month, day, hour: w.hour, minute: w.minute };
}

// ---------------------------------------------------------------------------
// Builder <-> expression
// ---------------------------------------------------------------------------

export type SchedulePreset = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

export interface ScheduleParts {
  preset: SchedulePreset;
  /** For `minutes`: the interval. */
  everyMinutes: number;
  /** For `hourly`/`daily`/`weekly`/`monthly`: minute past the hour. */
  minute: number;
  /** For `daily`/`weekly`/`monthly`. */
  hour: number;
  /** For `weekly`: 0-6, Sunday first. */
  weekday: number;
  /** For `monthly`: day of month. */
  dayOfMonth: number;
  /** For `custom`: the raw expression, and what any preset falls back to displaying. */
  custom: string;
}

export const DEFAULT_SCHEDULE_PARTS: ScheduleParts = {
  preset: 'daily',
  everyMinutes: 5,
  minute: 0,
  hour: 3,
  weekday: 1,
  dayOfMonth: 1,
  custom: '0 3 * * *',
};

/** The minute intervals the builder offers. Each divides 60, so the schedule doesn't drift at the
 * top of the hour: a 7-minute interval would fire at :56 then :00, four minutes later. */
export const MINUTE_INTERVALS = [1, 2, 5, 10, 15, 20, 30];

/** The expression a set of builder controls represents. */
export function partsToCron(parts: ScheduleParts): string {
  switch (parts.preset) {
    case 'minutes':
      return parts.everyMinutes === 1 ? '* * * * *' : `*/${String(parts.everyMinutes)} * * * *`;
    case 'hourly':
      return `${String(parts.minute)} * * * *`;
    case 'daily':
      return `${String(parts.minute)} ${String(parts.hour)} * * *`;
    case 'weekly':
      return `${String(parts.minute)} ${String(parts.hour)} * * ${String(parts.weekday)}`;
    case 'monthly':
      return `${String(parts.minute)} ${String(parts.hour)} ${String(parts.dayOfMonth)} * *`;
    case 'custom':
      return parts.custom.trim();
  }
}

/**
 * The builder controls that would produce `expr`, so opening an existing job for editing lands on
 * the right preset instead of dumping everyone into the raw field. Anything the presets can't
 * represent exactly — a list of weekdays, a month restriction, an odd interval — comes back as
 * `custom` with the expression intact, which is the honest answer: silently snapping it to the
 * nearest preset would change the schedule.
 */
export function cronToParts(expr: string): ScheduleParts {
  const trimmed = expr.trim();
  const base: ScheduleParts = { ...DEFAULT_SCHEDULE_PARTS, preset: 'custom', custom: trimmed };

  const expanded = ALIAS_EXPANSIONS[trimmed] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5 || !isValidCron(expanded)) return base;

  const [minuteField, hourField, domField, monthField, dowField] = fields as [string, string, string, string, string];
  // A preset only claims an expression it reproduces exactly, so month restrictions disqualify all
  // of them outright.
  if (monthField !== '*') return base;

  const isNumber = (field: string): boolean => /^\d+$/.test(field);

  if (minuteField === '*' && hourField === '*' && domField === '*' && dowField === '*') {
    return { ...base, preset: 'minutes', everyMinutes: 1 };
  }

  const stepMatch = /^\*\/(\d+)$/.exec(minuteField);
  if (stepMatch && hourField === '*' && domField === '*' && dowField === '*') {
    const step = Number(stepMatch[1]);
    if (MINUTE_INTERVALS.includes(step)) return { ...base, preset: 'minutes', everyMinutes: step };
    return base;
  }

  if (!isNumber(minuteField)) return base;
  const minute = Number(minuteField);

  if (hourField === '*' && domField === '*' && dowField === '*') {
    return { ...base, preset: 'hourly', minute };
  }

  if (!isNumber(hourField)) return base;
  const hour = Number(hourField);

  if (domField === '*' && dowField === '*') {
    return { ...base, preset: 'daily', minute, hour };
  }
  if (domField === '*' && isNumber(dowField)) {
    const weekday = Number(dowField) % 7; // cron's 7 is Sunday, same as 0
    return { ...base, preset: 'weekly', minute, hour, weekday };
  }
  if (dowField === '*' && isNumber(domField)) {
    return { ...base, preset: 'monthly', minute, hour, dayOfMonth: Number(domField) };
  }

  return base;
}
