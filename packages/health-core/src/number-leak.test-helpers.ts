/**
 * Test helper: where a number sits in a value. A pin like
 * `expect(JSON.stringify(x)).not.toContain('1.9')` fails whenever a timestamp
 * ("…01.990Z") or an id ("…a777b…") holds those digits, so it is flaky by
 * chance (deploy gate run 42947068545; docs/gotchas.md). This walks the value
 * instead and returns the path of every place n appears:
 * - a number equal to n;
 * - a string holding n as a whole token, not inside a longer number or word
 *   ("1.9 mmol/L" and "1.9." match; "01.990", "11.9", "1.95" and "v1.9" do not).
 *   UUIDs and ISO date-times are blanked out first, since their digit groups
 *   can stand alone ("…-2026-…", "T02:45").
 * A string that is itself JSON is searched as text, so a serialized body works.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;

export function numberPaths(value: unknown, n: number): string[] {
  const digits = String(n).replace(/[.+-]/g, '\\$&');
  const token = new RegExp(`(?<![\\w.])${digits}(?!\\w|\\.\\d)`);
  const found: string[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number') { if (v === n) found.push(path); return; }
    if (typeof v === 'string') { if (token.test(v.replace(UUID, ' ').replace(ISO_TIME, ' '))) found.push(path); return; }
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const [key, child] of Object.entries(v)) walk(child, `${path}.${key}`);
  };
  walk(value, '$');
  return found;
}
