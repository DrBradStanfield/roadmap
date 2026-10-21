/**
 * The erased record's arithmetic (US-11 AC7, US-09 AC20, AC23, US-17 AC4).
 * The widget's store tests pin the same rules end to end; these pin them in
 * the engine, where the iPhone app reaches them.
 */
import { describe, expect, it } from 'vitest';
import { buildErasedFile } from './erase';
import { mergeFiles } from './merge';
import { CURRENT_SCHEMA_VERSION, createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';

const NOW = '2026-10-21T12:00:00.000Z';
const ctx = { deviceId: 'eraser', now: NOW };

function record(opts: { epoch?: number; updatedAt?: string; ids?: string[]; erased?: { fromEpoch: number; ids: string[] } } = {}): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'd', now: '2026-10-01T00:00:00.000Z' });
  if (opts.epoch) file.meta.eraseEpoch = opts.epoch;
  if (opts.updatedAt) file.meta.updatedAt = opts.updatedAt;
  if (opts.erased) {
    file.erasedRows = opts.erased;
    file.schemaVersion = CURRENT_SCHEMA_VERSION;
  }
  for (const id of opts.ids ?? []) {
    file.measurements.push(createMeasurement({ id, metricType: 'weight', value: 70, recordedAt: '2026-10-01', createdAt: '2026-10-01T00:00:00.000Z' }));
  }
  return file;
}

describe('buildErasedFile', () => {
  it('bumps the epoch one past the stored copy and its own, whichever is higher (US-11 AC7)', () => {
    expect(buildErasedFile({ stored: record({ epoch: 3 }), own: record({ epoch: 1 }), device: null, ctx }).meta.eraseEpoch).toBe(4);
    expect(buildErasedFile({ stored: record({ epoch: 1 }), own: record({ epoch: 5 }), device: null, ctx }).meta.eraseEpoch).toBe(6);
    expect(buildErasedFile({ stored: null, own: record(), device: null, ctx }).meta.eraseEpoch).toBe(1);
  });

  it('lists the root id of every row in the stored, own and device copies, and every id already listed (US-09 AC23)', () => {
    const file = buildErasedFile({
      stored: record({ ids: ['s1'], erased: { fromEpoch: 1, ids: ['old'] }, epoch: 1 }),
      own: record({ ids: ['o1', 'o1#si'], epoch: 1 }),
      device: record({ ids: ['d1'] }),
      ctx,
    });
    expect(file.erasedRows?.ids).toEqual(['d1', 'o1', 'old', 's1']);
    expect(file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(file.measurements).toEqual([]);
  });

  it("keeps the merged list's fromEpoch, and is the first to list when there is none (US-09 AC23)", () => {
    const listed = buildErasedFile({
      stored: record({ epoch: 2, erased: { fromEpoch: 2, ids: [] } }),
      own: record({ epoch: 2, erased: { fromEpoch: 1, ids: [] } }),
      device: null,
      ctx,
    });
    expect(listed.erasedRows?.fromEpoch).toBe(2);
    // No list anywhere: this erase, at epoch 1, is the first to list.
    expect(buildErasedFile({ stored: record(), own: record(), device: null, ctx }).erasedRows?.fromEpoch).toBe(1);
    // A stored copy that could not be read: only the own list counts.
    expect(buildErasedFile({ stored: null, own: record({ epoch: 4, erased: { fromEpoch: 3, ids: ['x'] } }), device: null, ctx }).erasedRows)
      .toEqual({ fromEpoch: 3, ids: ['x'] });
  });

  it('stamps erasedAt 1 ms past now, or past the latest write it has seen (US-09 AC20)', () => {
    expect(buildErasedFile({ stored: record(), own: record(), device: null, ctx }).meta.erasedAt).toBe('2026-10-21T12:00:00.001Z');
    // A slow eraser clock: the stored copy was written after "now".
    const slow = buildErasedFile({ stored: record({ updatedAt: '2026-10-21T15:00:00.000Z' }), own: record(), device: null, ctx });
    expect(slow.meta.erasedAt).toBe('2026-10-21T15:00:00.001Z');
    // A clock more than a day ahead is broken, not slow: it reads as now.
    const broken = buildErasedFile({ stored: record({ updatedAt: '2099-01-01T00:00:00.000Z' }), own: record(), device: null, ctx });
    expect(broken.meta.erasedAt).toBe('2026-10-21T12:00:00.001Z');
    // An unparseable stamp is ignored the same way.
    const garbage = buildErasedFile({ stored: record({ updatedAt: 'not a date' }), own: record(), device: null, ctx });
    expect(garbage.meta.erasedAt).toBe('2026-10-21T12:00:00.001Z');
  });

  it('carries a reminders decision as cancelled, never the token or the address (US-17 AC4)', () => {
    const own = record();
    own.reminderOptIn = { status: 'active', token: 'secret', email: 'a@b.c', provider: 'dropbox', updatedAt: NOW, lamport: 7 };
    expect(buildErasedFile({ stored: null, own, device: null, ctx }).reminderOptIn)
      .toEqual({ status: 'cancelled', token: '', email: '', provider: 'dropbox', updatedAt: NOW, lamport: 1 });
    expect(buildErasedFile({ stored: null, own: record(), device: null, ctx }).reminderOptIn).toBeUndefined();
  });

  it('wins the merge against the copy it erased, and drops every listed row (US-11)', () => {
    const stored = record({ ids: ['a', 'b'] });
    const erased = buildErasedFile({ stored, own: stored, device: null, ctx });
    const merged = mergeFiles(erased, stored, ctx);
    expect(merged.meta.eraseEpoch).toBe(1);
    expect(merged.measurements).toEqual([]);
  });
});
