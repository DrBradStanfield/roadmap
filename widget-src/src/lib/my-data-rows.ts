// Pure helpers for the phone's My data rows and value pages (US-62 AC8-AC10):
// one reading per day, newest first, the trend the iPhone draws, and the
// row's "Oct 2026" date. Data in, data out.

import { localDay, type ApiMeasurement } from '@roadmap/health-core';
import { activeRowIndex } from './matrix-save';

/** One day's active value: a metric's row, or a blood pressure's two halves. */
export interface DayReading {
  day: string; // yyyy-mm-dd
  id: string;
  value: number; // as stored: SI for a core metric, the systolic half of a pressure
  dia?: { id: string; value: number };
}

/** The active value per day for `metric` (the slot's first, as the matrices
 *  read it), newest first. */
export function readingsOf(history: ApiMeasurement[], metric: string): DayReading[] {
  const days: DayReading[] = [];
  for (const [key, row] of activeRowIndex(history)) {
    const day = key.slice(0, 10);
    if (row.metricType === metric) days.push({ day, id: row.id, value: row.value });
  }
  return days.sort((a, b) => b.day.localeCompare(a.day));
}

/** A blood pressure per day, both halves present (a half-pair is no reading:
 *  BP is atomic, `bpPairReady`), newest first. */
export function pressureReadings(history: ApiMeasurement[]): DayReading[] {
  const dia = new Map(readingsOf(history, 'diastolic_bp').map(r => [r.day, r]));
  return readingsOf(history, 'systolic_bp').flatMap(sys => {
    const d = dia.get(sys.day);
    return d ? [{ ...sys, dia: { id: d.id, value: d.value } }] : [];
  });
}

/** The recent days, oldest first, as the iPhone's rows draw them (US-25
 *  AC17f, ios/engine/my-data.ts `trends`): the last 30 days, today
 *  included, or the last seven days however old when those 30 hold fewer
 *  than two. A day after today is left out. `readings` newest first. */
export function recentTrend(readings: DayReading[], now = new Date()): DayReading[] {
  const today = localDay(now);
  const from = new Date(Date.parse(today) - 29 * 86_400_000).toISOString().slice(0, 10);
  const past = readings.filter(r => r.day <= today).reverse();
  const recent = past.filter(r => r.day >= from);
  return recent.length >= 2 ? recent : past.slice(-7);
}

/** A row's date: "Oct 2026", the day it is filed under. */
export function monthYear(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
