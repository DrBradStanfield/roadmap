// The recent days a row's small trend line draws, as Apple Health's cards do
// (US-25 AC17f, US-62 AC8): the web's phone rows, the iPhone's rows and the
// lab test rows all take this one window.

import { localDay } from './merge';

/** The window for `now`: the last 30 days (today, the phone's local day, and
 *  the 29 before), or the last seven readings however old when those 30 hold
 *  fewer than two. A day after today is left out of both. Today and the
 *  window's start are worked out once, for every series it is applied to.
 *  `oldestFirst` in, oldest first out; `dayOf` gives a reading's yyyy-mm-dd. */
export function trendWindow(now: Date): <T>(oldestFirst: T[], dayOf: (reading: T) => string) => T[] {
  const today = localDay(now);
  const from = new Date(Date.parse(today) - 29 * 86_400_000).toISOString().slice(0, 10);
  return (oldestFirst, dayOf) => {
    const past = oldestFirst.filter(r => dayOf(r) <= today);
    const recent = past.filter(r => dayOf(r) >= from);
    return recent.length >= 2 ? recent : past.slice(-7);
  };
}

/** The recent readings of one series, `readings` newest first, oldest first out. */
export function recentTrend<T extends { day: string }>(readings: T[], now = new Date()): T[] {
  return trendWindow(now)([...readings].reverse(), r => r.day);
}

/** The vertical range a small trend line is drawn over (US-62 AC8a, Brad 2026-11-09):
 *  its points' lowest to highest, widened about their middle to at least ±5% of the
 *  latest (last) point, so 0.57 to 0.58 draws nearly flat while a real change still
 *  fills the line. Points that all equal zero keep a span of one. The iPhone's
 *  Sparkline (ValueRow.swift `Sparkline.range`) is its twin, tested on the same cases. */
export function trendRange(points: number[]): { low: number; high: number } {
  const low = Math.min(...points), high = Math.max(...points);
  const span = Math.max(high - low, 0.1 * Math.abs(points[points.length - 1])) || 1;
  const middle = (low + high) / 2;
  return { low: middle - span / 2, high: middle + span / 2 };
}
