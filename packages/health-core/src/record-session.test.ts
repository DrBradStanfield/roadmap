/**
 * What the open record counts as a change (US-34 AC3, US-09 AC23, US-16
 * AC2a). The widget's live-refresh tests pin the same rules through the store.
 */
import { describe, expect, it } from 'vitest';
import { contentOf, eraseIdentityOf, visibleContentOf } from './record-session';
import { mergeFiles } from './merge';
import { CURRENT_SCHEMA_VERSION, createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';

const ctx = { deviceId: 'd', now: '2026-10-21T00:00:00.000Z' };
const row = (id: string) =>
  createMeasurement({ id, metricType: 'weight', value: 70, recordedAt: `2026-10-0${id.length}`, createdAt: ctx.now });

function file(ids: string[] = []): RoadmapFile {
  const f = createEmptyFile(ctx);
  f.measurements.push(...ids.map(row));
  return f;
}

describe('contentOf', () => {
  it('ignores the file clocks, and sees a row (US-34)', () => {
    const a = file(['a']);
    const b = structuredClone(a);
    b.meta.updatedAt = '2027-01-01T00:00:00.000Z';
    b.meta.lamport = 9;
    expect(contentOf(b)).toBe(contentOf(a));
    expect(contentOf(file(['a', 'bb']))).not.toBe(contentOf(a));
  });

  it('sees row order, unlike visibleContentOf (US-34 AC3)', () => {
    const a = file(['a', 'bb']);
    const b = file(['bb', 'a']);
    expect(contentOf(b)).not.toBe(contentOf(a));
    expect(visibleContentOf(b)).toBe(visibleContentOf(a));
  });
});

describe('visibleContentOf', () => {
  it('leaves out row clocks, the erase list and the schema version (US-34 AC3, US-09 AC23)', () => {
    const a = file(['a']);
    const b = structuredClone(a);
    b.erasedRows = { fromEpoch: 1, ids: ['gone'] };
    b.schemaVersion = CURRENT_SCHEMA_VERSION;
    expect(visibleContentOf(b)).toBe(visibleContentOf(a));
    // A merge with an empty copy changes nothing a person sees.
    expect(visibleContentOf(mergeFiles(a, createEmptyFile(ctx), ctx))).toBe(visibleContentOf(a));
  });

  it('sees an erase that leaves an empty record empty (US-16 AC2a)', () => {
    const before = file();
    const after = structuredClone(before);
    after.meta.eraseEpoch = 1;
    after.meta.erasedAt = '2026-10-21T00:00:00.001Z';
    expect(visibleContentOf(after)).not.toBe(visibleContentOf(before));
    expect(contentOf(after)).not.toBe(contentOf(before));
  });
});

describe('eraseIdentityOf', () => {
  it('moves with the epoch and with a later erase at the same epoch (US-16 AC2a)', () => {
    const a = file();
    const b = structuredClone(a);
    b.meta.eraseEpoch = 1;
    const c = structuredClone(b);
    c.meta.erasedAt = '2026-10-21T00:00:00.001Z';
    expect(new Set([a, b, c].map(eraseIdentityOf)).size).toBe(3);
    expect(eraseIdentityOf(file(['a']))).toBe(eraseIdentityOf(a));
  });
});
