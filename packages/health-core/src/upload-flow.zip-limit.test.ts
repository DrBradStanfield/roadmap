/**
 * upload-flow.ts: a ZIP that will not open (US-12 AC9), picked order whatever order listings finish
 * in (US-12 AC23), and the daily limit ending a run's reading (US-12 AC9, AC26). Owner rulings on
 * PR 1838's review, items 1, 2 and 4.
 */
import { describe, expect, it } from 'vitest';
import type { UnifiedExtractionResult } from './lab-extraction';
import { initialUpload, saveEnabled, transition, type UploadEvent, type UploadState } from './upload-flow';

const EXT: UnifiedExtractionResult = { classification: 'other', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: null };
const NOW = '2026-11-15T00:00:00Z';
const pick = (files: Array<{ id: string; name: string; kind?: 'file' | 'zip' }>): UploadEvent =>
  ({ type: 'picked', files: files.map((f) => ({ bytes: 1, kind: 'file', ...f })), needsConsent: false, now: NOW });
const ids = (s: UploadState) => ('files' in s ? s.files.map((f) => f.id) : []);
const stages = (s: UploadState) => ('files' in s ? s.files.map((f) => `${f.id}:${f.status.s}`) : []);
const run = (s: UploadState, events: UploadEvent[]) => events.reduce((st, e) => transition(st, e).state, s);
const member = (id: string) => ({ id, name: `${id}.pdf`, bytes: 1 });

describe('a ZIP that will not open (US-12 AC9)', () => {
  const start = transition(initialUpload('web'), pick([{ id: 'a', name: 'a.pdf' }, { id: 'z', name: 'z.zip', kind: 'zip' }, { id: 'b', name: 'b.pdf' }])).state;

  it('drops only that ZIP, named as a failed entry in its place; the rest of the run goes on', () => {
    const read = run(start, [
      { type: 'hashed', run: 1, id: 'a', hash: 'ha', known: null },
      { type: 'converted', run: 1, id: 'a', pages: 1, truncated: false },
      { type: 'answered', run: 1, id: 'a', extraction: EXT, legacy: false, now: NOW },
      { type: 'chose', id: 'a', change: { tick: 'v0', on: false } },
    ]);
    const { state, effects } = transition(read, { type: 'zipFailed', run: 1, zip: 'z' });
    expect(state.phase).toBe('open');
    expect(stages(state)).toEqual(['a:read', 'z:failed', 'b:waiting']);
    expect(state.phase === 'open' && state.files[1]).toMatchObject({ name: 'z.zip', status: { s: 'failed', reason: 'zipUnreadable' } });
    expect(state.phase === 'open' && state.files[0].status).toMatchObject({ s: 'read', extraction: EXT, choices: { ticks: { v0: false } } });
    expect(effects).toEqual([{ type: 'forget', run: 1, ids: ['z'] }]);
  });

  it('fails the pick as a whole only when it held nothing else', () => {
    const lone = transition(initialUpload('web'), pick([{ id: 'z', name: 'z.zip', kind: 'zip' }])).state;
    const { state } = transition(lone, { type: 'zipFailed', run: 1, zip: 'z' });
    expect(state).toMatchObject({ phase: 'failed', files: [{ id: 'z', name: 'z.zip', status: { s: 'failed', reason: 'zipUnreadable' } }] });
    const two = transition(initialUpload('web'), pick([{ id: 'y', name: 'y.zip', kind: 'zip' }, { id: 'z', name: 'z.zip', kind: 'zip' }])).state;
    const first = transition(two, { type: 'zipFailed', run: 1, zip: 'y' }).state;
    expect(first.phase).toBe('open');
    expect(transition(first, { type: 'zipFailed', run: 1, zip: 'z' }).state.phase).toBe('failed');
  });

  it('a late or stale zipFailed changes nothing: after the listing, after Stop, for an old run', () => {
    const listed = transition(start, { type: 'listed', run: 1, zip: 'z', members: [member('m1')] }).state;
    expect(transition(listed, { type: 'zipFailed', run: 1, zip: 'z' })).toEqual({ state: listed, effects: [] });
    const stopped = transition(start, { type: 'stop' }).state;
    expect(transition(stopped, { type: 'zipFailed', run: 1, zip: 'z' })).toEqual({ state: stopped, effects: [] });
    expect(transition(start, { type: 'zipFailed', run: 0, zip: 'z' })).toEqual({ state: start, effects: [] });
    const next = transition(transition(start, { type: 'discard' }).state, pick([{ id: 'z2', name: 'z.zip', kind: 'zip' }])).state;
    expect(transition(next, { type: 'zipFailed', run: 1, zip: 'z2' })).toEqual({ state: next, effects: [] });
  });
});

describe('picked order whatever order listings finish (US-12 AC23)', () => {
  it('two ZIPs listed in reverse order keep their members in picked order', () => {
    const s = transition(initialUpload('web'), pick([{ id: 'y', name: 'y.zip', kind: 'zip' }, { id: 'z', name: 'z.zip', kind: 'zip' }])).state;
    const done = run(s, [
      { type: 'listed', run: 1, zip: 'z', members: [member('z1'), member('z2')] },
      { type: 'listed', run: 1, zip: 'y', members: [member('y1'), member('y2')] },
    ]);
    expect(ids(done)).toEqual(['y1', 'y2', 'z1', 'z2']);
  });

  it('a ZIP among direct files has its members at its place', () => {
    const s = transition(initialUpload('web'), pick([
      { id: 'a', name: 'a.pdf' }, { id: 'z', name: 'z.zip', kind: 'zip' }, { id: 'b', name: 'b.pdf' }, { id: 'y', name: 'y.zip', kind: 'zip' }, { id: 'c', name: 'c.pdf' },
    ])).state;
    const done = run(s, [
      { type: 'listed', run: 1, zip: 'y', members: [member('y1')] },
      { type: 'hashed', run: 1, id: 'c', hash: 'hc', known: null },
      { type: 'listed', run: 1, zip: 'z', members: [member('z1'), member('z2')] },
    ]);
    expect(ids(done)).toEqual(['a', 'z1', 'z2', 'b', 'y1', 'c']);
  });
});

describe('the daily limit ends the run\'s reading (US-12 AC9, AC26)', () => {
  it('20 files: sends in flight finish, nothing new starts, every unsent file fails on the limit, Save works', () => {
    const picked = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, name: `f${i}.pdf` }));
    let s = transition(initialUpload('web'), pick(picked)).state;
    for (let i = 0; i < 20; i++) s = transition(s, { type: 'hashed', run: 1, id: `f${i}`, hash: `h${i}`, known: null }).state;
    // Eight converted: five sending, three ready behind them, three more converting.
    for (let i = 0; i < 8; i++) s = transition(s, { type: 'converted', run: 1, id: `f${i}`, pages: 1, truncated: false }).state;
    s = transition(s, { type: 'answered', run: 1, id: 'f0', extraction: EXT, legacy: false, now: NOW }).state;
    s = transition(s, { type: 'chose', id: 'f0', change: { tick: 'v0', on: false } }).state;
    expect(stages(s).slice(0, 12)).toEqual(['f0:read', ...[1, 2, 3, 4, 5].map((i) => `f${i}:sending`), 'f6:ready', 'f7:ready', 'f8:converting', 'f9:converting', 'f10:converting', 'f11:hashed']);

    const limit = transition(s, { type: 'sendFailed', run: 1, id: 'f1', failure: 'rate_limit' });
    expect(limit.effects.filter((f) => f.type === 'send' || f.type === 'convert')).toEqual([]);
    expect(stages(limit.state)).toEqual(['f0:read', 'f1:failed', 'f2:sending', 'f3:sending', 'f4:sending', 'f5:sending', ...Array.from({ length: 14 }, (_, i) => `f${i + 6}:failed`)]);
    expect('files' in limit.state && limit.state.files.filter((f) => f.status.s === 'failed').every((f) => f.status.s === 'failed' && f.status.reason === 'dailyLimit')).toBe(true);
    expect(limit.effects).toEqual([{ type: 'forget', run: 1, ids: ['f1', ...Array.from({ length: 14 }, (_, i) => `f${i + 6}`)] }]);

    // The four in flight finish: one read, one busy (a retry would send again, so it fails on the limit too).
    let after = run(limit.state, [
      { type: 'answered', run: 1, id: 'f2', extraction: EXT, legacy: false, now: NOW },
      { type: 'sendFailed', run: 1, id: 'f3', failure: 'busy' },
      { type: 'converted', run: 1, id: 'f8', pages: 1, truncated: false }, // a convert that landed late: dropped
    ]);
    expect(stages(after).slice(2, 4)).toEqual(['f2:read', 'f3:failed']);
    expect('files' in after && after.files[3].status).toMatchObject({ reason: 'dailyLimit' });
    expect(transition(after, { type: 'retry', id: 'all' }).effects).toEqual([]);
    after = run(after, [
      { type: 'answered', run: 1, id: 'f4', extraction: EXT, legacy: false, now: NOW },
      { type: 'answered', run: 1, id: 'f5', extraction: EXT, legacy: false, now: NOW },
    ]);
    expect(saveEnabled(after)).toBe(true);
    expect('files' in after && after.files[0].status).toMatchObject({ s: 'read', choices: { ticks: { v0: false } } });
    expect(transition(after, { type: 'saveStarted' }).effects).toEqual([{ type: 'save', run: 1, attempt: 1 }]);
  });

  it('a ZIP not yet listed fails on the limit too, and its late listing adds nothing', () => {
    let s = transition(initialUpload('web'), pick([{ id: 'a', name: 'a.pdf' }, { id: 'z', name: 'z.zip', kind: 'zip' }])).state;
    s = run(s, [{ type: 'hashed', run: 1, id: 'a', hash: 'ha', known: null }, { type: 'converted', run: 1, id: 'a', pages: 1, truncated: false }]);
    s = transition(s, { type: 'sendFailed', run: 1, id: 'a', failure: 'rate_limit' }).state;
    expect(stages(s)).toEqual(['a:failed', 'z:failed']);
    expect(transition(s, { type: 'listed', run: 1, zip: 'z', members: [member('m')] })).toEqual({ state: s, effects: [] });
  });
});
