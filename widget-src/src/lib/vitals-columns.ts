// The vitals history folded into the matrix's date columns
// (StartingInfoVitals): one column per distinct date, sys+dia paired.

import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { comparatorOf, type Comparator } from '@roadmap/health-core/lab-limits';

// ── Date helpers ─────────────────────────────────────────────────────────

function isoOnly(s: string): string { return s.slice(0, 10); }

// ── Per-date model ───────────────────────────────────────────────────────
// One column per distinct date. Each column carries the SI value + row id for
// every vital recorded that day (sparse — a date may hold only a weight).

export interface DateColumn {
  date: string;
  weight?: number; weightId?: string;
  waist?: number; waistId?: string;
  sys?: number; sysId?: string;
  dia?: number; diaId?: string;
  /** Each value printed as a limit: its symbol's code, the value its bound (US-12 AC20, AC21). */
  limits?: Partial<Record<'weight' | 'waist' | 'sys' | 'dia', Comparator>>;
}

// Exported for unit testing — folds the flat vitals history into one column
// per distinct date (sparse: a date may carry only some vitals), sorted oldest
// → newest. sys+dia sharing a date are paired into the same column.
export function buildColumns(rows: ApiMeasurement[]): DateColumn[] {
  const byDate = new Map<string, DateColumn>();
  const ensure = (date: string) => {
    let c = byDate.get(date);
    if (!c) { c = { date }; byDate.set(date, c); }
    return c;
  };
  const keyOf: Record<string, 'weight' | 'waist' | 'sys' | 'dia'> = { weight: 'weight', waist: 'waist', systolic_bp: 'sys', diastolic_bp: 'dia' };
  for (const r of rows) {
    const date = isoOnly(r.recordedAt);
    const c = ensure(date);
    if (r.metricType === 'weight') { c.weight = r.value; c.weightId = r.id; }
    else if (r.metricType === 'waist') { c.waist = r.value; c.waistId = r.id; }
    else if (r.metricType === 'systolic_bp') { c.sys = r.value; c.sysId = r.id; }
    else if (r.metricType === 'diastolic_bp') { c.dia = r.value; c.diaId = r.id; }
    const key = keyOf[r.metricType];
    if (!key) continue;
    // The value now in the slot carries its own limit, or none (a later exact row replaces a limit).
    const { comparator } = comparatorOf(r);
    const { [key]: _old, ...others } = c.limits ?? {};
    c.limits = comparator ? { ...others, [key]: comparator } : others;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
