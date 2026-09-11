import { DateTime } from "luxon";

export function toMinutes(hhmm: number): number {
  return Math.floor(hhmm / 100) * 60 + (hhmm % 100);
}

export type PickNextRunOptions = {
  /** Epoch millis of other jobs' scheduled runs to stay clear of. */
  occupied?: number[];
  /** Minimum spacing from occupied slots, in minutes. 0 disables staggering. */
  gapMinutes?: number;
  /**
   * Placing a run that was due earlier today and never happened. What is left of the window
   * is no room for a day's worth of missed runs, so the rest of the day is used instead.
   */
  catchUp?: boolean;
};

const MINUTES_IN_DAY = 24 * 60;

const MAX_RANDOM_ATTEMPTS = 20;

function atMinute(day: DateTime, minuteOfDay: number): DateTime {
  return day.set({
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
    millisecond: 0,
  });
}

/**
 * Picks a random minute in [startMin, endMin) on the given day, staying at
 * least gapMinutes away from every occupied slot. When the window is too
 * crowded to honour the gap, falls back to the minute furthest from its
 * nearest neighbour so behaviour degrades gracefully.
 */
function pickMinute(
  day: DateTime,
  startMin: number,
  endMin: number,
  opts: PickNextRunOptions,
): DateTime {
  const span = Math.max(1, endMin - startMin);
  const randomPick = () =>
    atMinute(day, startMin + Math.floor(Math.random() * span));

  const gapMs = (opts.gapMinutes ?? 0) * 60_000;
  const occupied = opts.occupied ?? [];
  if (gapMs <= 0 || occupied.length === 0) return randomPick();

  const clearance = (candidate: DateTime) => {
    const ms = candidate.toMillis();
    return Math.min(...occupied.map((slot) => Math.abs(slot - ms)));
  };

  for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
    const candidate = randomPick();
    if (clearance(candidate) >= gapMs) return candidate;
  }

  let best = atMinute(day, startMin);
  let bestClearance = clearance(best);
  for (let m = startMin + 1; m < endMin; m++) {
    const candidate = atMinute(day, m);
    const c = clearance(candidate);
    if (c > bestClearance) {
      best = candidate;
      bestClearance = c;
    }
  }
  return best;
}

export function pickNextRun(
  windowStart: number,
  windowEnd: number,
  tz: string,
  daysAhead = 0,
  options: PickNextRunOptions = {},
): DateTime {
  const startMin = toMinutes(windowStart);
  const endMin = toMinutes(windowEnd);
  const now = DateTime.now().setZone(tz);
  const nowMin = now.hour * 60 + now.minute;

  if (daysAhead === 0) {
    if (nowMin < startMin) return pickMinute(now, startMin, endMin, options);
    // A catch-up run is already late, so it takes the rest of the day rather than the sliver
    // of window that is left -- dropping it to tomorrow is what loses the run entirely
    if (options.catchUp && nowMin + 1 < MINUTES_IN_DAY)
      return pickMinute(now, nowMin + 1, MINUTES_IN_DAY, options);
    if (nowMin + 1 < endMin)
      return pickMinute(now, nowMin + 1, endMin, options);
    // Past window or under a minute left -- schedule tomorrow
    daysAhead = 1;
  }

  return pickMinute(now.plus({ days: daysAhead }), startMin, endMin, options);
}
