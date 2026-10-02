/**
 * US-32 AC38 — our own proof runs file a twin of the reviewer's sample report,
 * never the report itself: its file name is the record's dedup key, so a proof
 * run that filed sample-lab-report.pdf would turn positive 4 into "already
 * imported" before the reviewer starts.
 */
import { describe, it, expect } from 'vitest';
import { basename } from 'node:path';
import { edition, REPORT } from './make-sample-lab-report.mjs';

describe('make-sample-lab-report.mjs — the reviewer edition and the proof variant', () => {
  it('writes the reviewer edition under its kept name and dates', () => {
    const { out, report } = edition(false);
    expect(basename(out)).toBe('sample-lab-report.pdf');
    expect(report).toEqual(REPORT);
    expect([report.collected, report.reported]).toEqual(['2026-09-28', '2026-09-29']);
  });

  it('writes the proof variant under another name, a week earlier, otherwise the same report', () => {
    const { out, report } = edition(true);
    expect(basename(out)).toBe('sample-lab-report-proof.pdf');
    expect(report).toEqual({ ...REPORT, collected: '2026-09-21', reported: '2026-09-22' });
  });
});
