/**
 * A fake `cron_lock` table behind a supabase-js-shaped builder, for the US-28
 * AC9 pins. It reads the PostgREST filters the code sends, `.or()` included,
 * with SQL's three-valued logic: a comparison with NULL is unknown, not false,
 * and a row is written only when the whole filter is true. Timestamps compare
 * as instants and come back in Postgres's own form (microseconds, `+00:00`),
 * so a string compare of `locked_at` fails here as it would live.
 */

export interface LockRow {
  lock_name: string;
  locked_by: string | null;
  locked_at: string | null;
  lock_date: string | null;
  run_state?: string | null;
  finished_at?: string | null;
}

type Tri = boolean | null;
const TIME_COLUMNS = new Set(['locked_at', 'finished_at']);

const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);

/** Split on commas outside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

function compare(column: string, cell: unknown, value: string): number {
  if (TIME_COLUMNS.has(column)) return Date.parse(String(cell)) - Date.parse(value);
  return String(cell) < value ? -1 : String(cell) > value ? 1 : 0;
}

/** One PostgREST condition (`col.op.value`, `and(...)`, `or(...)`) against a row. */
function evalTerm(term: string, row: Record<string, unknown>): Tri {
  if (term.startsWith('and(')) return and(splitTop(term.slice(4, -1)).map((t) => evalTerm(t, row)));
  if (term.startsWith('or(')) return or(splitTop(term.slice(3, -1)).map((t) => evalTerm(t, row)));
  const [column, op, ...rest] = term.split('.');
  const value = rest.join('.');
  const cell = row[column] ?? null;
  if (op === 'is') {
    if (value !== 'null') throw new Error(`fake cron_lock: unsupported is.${value}`);
    return cell === null;
  }
  if (cell === null) return null;
  if (op === 'eq') return compare(column, cell, value) === 0;
  if (op === 'neq') return compare(column, cell, value) !== 0;
  if (op === 'lt') return compare(column, cell, value) < 0;
  if (op === 'gt') return compare(column, cell, value) > 0;
  if (op === 'in') return value.replace(/^\(|\)$/g, '').split(',').includes(String(cell));
  throw new Error(`fake cron_lock: unsupported operator ${op}`);
}

/** Postgres's text form of a timestamptz: microseconds and `+00:00`. */
export const pgTime = (iso: string | null | undefined): string | null =>
  iso ? new Date(iso).toISOString().replace('Z', '000+00:00') : null;

export interface FakeLockDb {
  rows: LockRow[];
  /** Every builder's method names, in call order, one list per `.from()`. */
  calls: string[][];
  /** Every `.or()` filter string sent. */
  filters: string[];
  /** Runs after each update lands (a writer racing in between the update and the verify). */
  afterUpdate: (() => void) | null;
  /** Answers tables other than cron_lock. */
  other: ((table: string) => unknown) | null;
}

export function makeFakeLockDb(): FakeLockDb {
  return { rows: [], calls: [], filters: [], afterUpdate: null, other: null };
}

export function fakeAdmin(db: FakeLockDb): { from: (table: string) => unknown } {
  return {
    from(table: string) {
      if (table !== 'cron_lock') return db.other?.(table);
      const calls: string[] = [];
      db.calls.push(calls);
      const preds: ((row: Record<string, unknown>) => Tri)[] = [];
      let patch: Record<string, unknown> | null = null;
      let single = false;
      const run = async () => {
        const hit = (r: LockRow) => and(preds.map((p) => p(r as unknown as Record<string, unknown>))) === true;
        if (patch) {
          for (const r of db.rows) if (hit(r)) Object.assign(r, patch);
          db.afterUpdate?.();
          return { data: null, error: null };
        }
        const found = db.rows.filter(hit).map((r) => ({ ...r, locked_at: pgTime(r.locked_at), finished_at: pgTime(r.finished_at) }));
        return { data: single ? found[0] ?? null : found, error: null };
      };
      const builder: Record<string, unknown> = {
        update: (p: Record<string, unknown>) => { calls.push('update'); patch = p; return builder; },
        select: () => { calls.push('select'); return builder; },
        eq: (c: string, v: unknown) => { calls.push('eq'); preds.push((r) => evalTerm(`${c}.eq.${v}`, r)); return builder; },
        is: (c: string, v: null) => { calls.push('is'); preds.push((r) => evalTerm(`${c}.is.${v}`, r)); return builder; },
        or: (f: string) => { calls.push('or'); db.filters.push(f); preds.push((r) => or(splitTop(f).map((t) => evalTerm(t, r)))); return builder; },
        maybeSingle: () => { calls.push('maybeSingle'); single = true; return run(); },
        then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => run().then(ok, fail),
      };
      return builder;
    },
  };
}
