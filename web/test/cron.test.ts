/**
 * `web/src/lib/cron.ts` — the parsing, description, next-run and builder-translation logic behind
 * the project Cron tab's schedule builder. Pure functions, so they're tested directly.
 *
 * The next-run cases matter most: they're the part a reader will trust without being able to check
 * it, and cron's day-matching rule (`dayMatches`) is a well-known trap.
 */
import { describe, expect, it } from 'vitest';
import {
  cronToParts,
  describeCron,
  formatWallClock,
  isValidCron,
  nextRuns,
  nowInTimezone,
  partsToCron,
  type ScheduleParts,
  type WallClock,
} from '../src/lib/cron';

function at(year: number, month: number, day: number, hour = 0, minute = 0): WallClock {
  return { year, month, day, hour, minute };
}

describe('isValidCron', () => {
  it('accepts the shapes the server accepts', () => {
    for (const expr of ['* * * * *', '*/5 * * * *', '0 3 * * *', '30 9 * * 1', '0 0 1 * *', '0 0 1 1 *', '15,45 * * * *', '0 9-17 * * 1-5', '0 0 * * 7']) {
      expect(isValidCron(expr), expr).toBe(true);
    }
  });

  it('accepts the aliases', () => {
    for (const alias of ['@hourly', '@daily', '@weekly', '@monthly', '@yearly', '@annually', '@reboot']) {
      expect(isValidCron(alias), alias).toBe(true);
    }
  });

  it('rejects malformed expressions', () => {
    for (const expr of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'every minute', '*/0 * * * *', '5-1 * * * *']) {
      expect(isValidCron(expr), expr).toBe(false);
    }
  });

  it('tolerates surrounding and repeated whitespace, as the server does', () => {
    expect(isValidCron('  0   3  *  *  * ')).toBe(true);
  });
});

describe('describeCron', () => {
  it('names the common shapes in plain English', () => {
    expect(describeCron('* * * * *')).toBe('Every minute');
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes');
    expect(describeCron('*/30 * * * *')).toBe('Every 30 minutes');
    expect(describeCron('0 * * * *')).toBe('Every hour at :00');
    expect(describeCron('15 * * * *')).toBe('Every hour at :15');
    expect(describeCron('0 */6 * * *')).toBe('Every 6 hours at :00');
    expect(describeCron('0 3 * * *')).toBe('Every day at 03:00');
    expect(describeCron('30 9 * * 1')).toBe('At 09:30 on Monday');
    expect(describeCron('0 0 1 * *')).toBe('At 00:00 on the 1st');
  });

  it('describes the aliases through their expansions', () => {
    expect(describeCron('@hourly')).toBe('Every hour at :00');
    expect(describeCron('@daily')).toBe('Every day at 03:00'.replace('03:00', '00:00'));
    expect(describeCron('@reboot')).toBe('At server boot');
  });

  it('lists multiple weekdays and days of month', () => {
    expect(describeCron('0 9 * * 1,3,5')).toBe('At 09:00 on Monday, Wednesday and Friday');
    expect(describeCron('0 9 1,15 * *')).toBe('At 09:00 on the 1st and 15th');
  });

  it('says "or" when both day fields are restricted, which is what cron actually does', () => {
    // The classic trap: this is "the 13th, OR any Friday", not "Friday the 13th".
    expect(describeCron('0 0 13 * 5')).toContain('or');
  });

  it('names a month restriction', () => {
    expect(describeCron('0 0 1 1 *')).toBe('At 00:00 on the 1st in January');
  });

  it('falls back to a composed sentence rather than giving up on an unusual expression', () => {
    expect(describeCron('0 9,17 * * 1-5')).toBe('At 09:00 and 17:00 on Monday, Tuesday, Wednesday, Thursday and Friday');
  });

  it('summarizes rather than listing when there are many times', () => {
    expect(describeCron('0,15,30,45 9,10 * * *')).toContain('8 times a day');
  });

  it('returns null for an invalid expression', () => {
    expect(describeCron('nonsense')).toBeNull();
    expect(describeCron('60 * * * *')).toBeNull();
  });
});

describe('nextRuns', () => {
  it('returns times strictly after the given moment, never the current minute', () => {
    const runs = nextRuns('*/5 * * * *', at(2026, 8, 29, 14, 30), 3);
    expect(runs).toEqual([at(2026, 8, 29, 14, 35), at(2026, 8, 29, 14, 40), at(2026, 8, 29, 14, 45)]);
  });

  it('rolls over to the next day when the time has passed', () => {
    expect(nextRuns('0 3 * * *', at(2026, 8, 29, 14, 30), 2)).toEqual([at(2026, 8, 30, 3, 0), at(2026, 8, 31, 3, 0)]);
  });

  it('rolls over the month and the year', () => {
    expect(nextRuns('0 0 1 * *', at(2026, 12, 15, 9, 0), 2)).toEqual([at(2027, 1, 1, 0, 0), at(2027, 2, 1, 0, 0)]);
  });

  it('finds the right weekday', () => {
    // 2026-08-29 is a Saturday, so the next Monday is the 31st.
    const runs = nextRuns('30 9 * * 1', at(2026, 8, 29, 12, 0), 2);
    expect(runs).toEqual([at(2026, 8, 31, 9, 30), at(2026, 9, 7, 9, 30)]);
  });

  it('honors cron\'s OR rule when both day fields are restricted', () => {
    // "the 13th, or any Friday" — August 2026's Fridays are the 7th, 14th, 21st, 28th.
    const runs = nextRuns('0 0 13 * 5', at(2026, 8, 10, 0, 0), 3);
    expect(runs).toEqual([at(2026, 8, 13, 0, 0), at(2026, 8, 14, 0, 0), at(2026, 8, 21, 0, 0)]);
  });

  it('skips months that do not have the requested day', () => {
    // The 31st: after August comes October, since September has 30 days.
    const runs = nextRuns('0 0 31 * *', at(2026, 8, 31, 1, 0), 2);
    expect(runs).toEqual([at(2026, 10, 31, 0, 0), at(2026, 12, 31, 0, 0)]);
  });

  it('resolves a once-a-year schedule that only exists in leap years', () => {
    const runs = nextRuns('0 0 29 2 *', at(2026, 3, 1, 0, 0), 1);
    expect(runs).toEqual([at(2028, 2, 29, 0, 0)]);
  });

  it('returns nothing for @reboot, which has no predictable next time', () => {
    expect(nextRuns('@reboot', at(2026, 8, 29, 14, 30), 3)).toEqual([]);
  });

  it('returns nothing for an invalid expression or a non-positive count', () => {
    expect(nextRuns('nonsense', at(2026, 8, 29), 3)).toEqual([]);
    expect(nextRuns('* * * * *', at(2026, 8, 29), 0)).toEqual([]);
  });
});

describe('nowInTimezone', () => {
  it('reads the wall clock in the named zone, not the browser\'s', () => {
    // 2026-08-29T12:00:00Z is 14:00 in Berlin (CEST) and 08:00 in New York (EDT).
    const instant = new Date('2026-08-29T12:00:00Z');
    expect(nowInTimezone('Europe/Berlin', instant)).toEqual(at(2026, 8, 29, 14, 0));
    expect(nowInTimezone('America/New_York', instant)).toEqual(at(2026, 8, 29, 8, 0));
    expect(nowInTimezone('UTC', instant)).toEqual(at(2026, 8, 29, 12, 0));
  });

  it('folds a midnight reported as hour 24 back to 0', () => {
    expect(nowInTimezone('UTC', new Date('2026-08-29T00:30:00Z')).hour).toBe(0);
  });

  it('falls back to the browser clock rather than throwing on an unknown zone', () => {
    expect(() => nowInTimezone('Not/AZone')).not.toThrow();
  });
});

describe('formatWallClock', () => {
  const today = at(2026, 8, 29, 14, 30);

  it('says Today and Tomorrow for the two days a reader can hold in their head', () => {
    expect(formatWallClock(at(2026, 8, 29, 16, 0), today)).toBe('Today at 16:00');
    expect(formatWallClock(at(2026, 8, 30, 3, 0), today)).toBe('Tomorrow at 03:00');
  });

  it('crosses a month boundary into Tomorrow correctly', () => {
    expect(formatWallClock(at(2026, 9, 1, 3, 0), at(2026, 8, 31, 14, 30))).toBe('Tomorrow at 03:00');
  });

  it('gives an absolute date beyond tomorrow', () => {
    expect(formatWallClock(at(2026, 9, 7, 9, 30), today)).toBe('Mon 7 Sep at 09:30');
  });
});

describe('partsToCron / cronToParts', () => {
  const parts = (overrides: Partial<ScheduleParts>): ScheduleParts => ({
    preset: 'daily',
    everyMinutes: 5,
    minute: 0,
    hour: 3,
    weekday: 1,
    dayOfMonth: 1,
    custom: '',
    ...overrides,
  });

  it('builds the expression each preset represents', () => {
    expect(partsToCron(parts({ preset: 'minutes', everyMinutes: 1 }))).toBe('* * * * *');
    expect(partsToCron(parts({ preset: 'minutes', everyMinutes: 15 }))).toBe('*/15 * * * *');
    expect(partsToCron(parts({ preset: 'hourly', minute: 20 }))).toBe('20 * * * *');
    expect(partsToCron(parts({ preset: 'daily', hour: 3, minute: 30 }))).toBe('30 3 * * *');
    expect(partsToCron(parts({ preset: 'weekly', hour: 9, minute: 0, weekday: 1 }))).toBe('0 9 * * 1');
    expect(partsToCron(parts({ preset: 'monthly', hour: 0, minute: 0, dayOfMonth: 15 }))).toBe('0 0 15 * *');
    expect(partsToCron(parts({ preset: 'custom', custom: '  0 9-17 * * 1-5 ' }))).toBe('0 9-17 * * 1-5');
  });

  it('round-trips every preset, so editing a job lands on the control that made it', () => {
    for (const p of [
      parts({ preset: 'minutes', everyMinutes: 1 }),
      parts({ preset: 'minutes', everyMinutes: 10 }),
      parts({ preset: 'hourly', minute: 45 }),
      parts({ preset: 'daily', hour: 23, minute: 5 }),
      parts({ preset: 'weekly', hour: 6, minute: 15, weekday: 0 }),
      parts({ preset: 'monthly', hour: 1, minute: 0, dayOfMonth: 28 }),
    ]) {
      const expr = partsToCron(p);
      const back = cronToParts(expr);
      expect(back.preset, expr).toBe(p.preset);
      expect(partsToCron(back), expr).toBe(expr);
    }
  });

  it('reads cron\'s Sunday-as-7 as the same weekday as 0', () => {
    expect(cronToParts('0 9 * * 7')).toMatchObject({ preset: 'weekly', weekday: 0 });
  });

  it('falls back to custom — keeping the expression intact — for anything no preset reproduces', () => {
    for (const expr of ['0 9,17 * * *', '0 9 * * 1-5', '0 0 1 1 *', '*/7 * * * *', '0 0 13 * 5']) {
      const back = cronToParts(expr);
      expect(back.preset, expr).toBe('custom');
      // Critically, it must not rewrite the schedule while failing to match it.
      expect(partsToCron(back), expr).toBe(expr);
    }
  });

  it('treats an invalid expression as custom rather than throwing', () => {
    expect(cronToParts('nonsense')).toMatchObject({ preset: 'custom', custom: 'nonsense' });
  });
});
