// PR 1848 Codex: a Save is held to the cloud session it was asked of. One queued on session A while
// A closes and B opens in its place (at the same erase identity) refuses not-open, and nothing of it
// lands in B. The window is too narrow for the bundled fake cloud (closing A stops its writes, so the
// queue drains before B opens), so `./cloud` is a stand-in here whose open session the test swaps.
import { describe, expect, it, vi } from 'vitest';
import { BusyError } from '../../packages/health-core/src/adapter';
import { createEmptyFile } from '../../packages/health-core/src/roadmap-file';
import { NO_CHOICES } from '../../packages/health-core/src/upload-choices';

const NOW = '2026-10-21T08:00:00.000Z';
const cloud = vi.hoisted(() => ({ open: null as unknown, commits: [] as unknown[] }));
vi.mock('./cloud', () => ({
  get open() { return cloud.open; },
  NOT_OPEN: 'The cloud record is not open.',
  ERASED: 'Your record was erased on another device, so this was not saved.',
  commit: (at: unknown, file: unknown) => { cloud.commits.push([at, file]); return null; },
}));
const { oneDocumentSaveAtATime } = await import('./cloud-documents');
const { uploadSaveRun } = await import('./upload-save-door');

/** A session as the door reads it: its record, its erase and a store that counts puts. */
function session(name: string) {
  const puts: string[] = [];
  const file = createEmptyFile({ deviceId: name, now: NOW });
  return { puts, at: { session: { file, refuses: () => false, eraseIdentity: '[0,null]' }, host: { store: { writeDocument: async (ref: string) => void puts.push(ref) } } } };
}
const letter = { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-09-14', contentMarkdown: '# Letter', metadata: {} } };
const STATE = JSON.stringify({ phase: 'saving', platform: 'phone', run: 1, started: NOW, firstRead: NOW, attempt: 1,
  files: [{ id: 'other', name: 'other.pdf', bytes: 1, hash: 'sha256-other', pages: { count: 1, truncated: false }, status: { s: 'read', extraction: letter, choices: NO_CHOICES } }] });

describe('a queued Save is held to the session it was asked of (PR 1848 Codex)', () => {
  it('A closes and B opens at the same erase while it waits: not-open, nothing put, nothing committed to B', async () => {
    const a = session('a');
    const b = session('b');
    cloud.open = a.at;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holding = oneDocumentSaveAtATime(() => gate.then(() => '{}'));
    const queued = uploadSaveRun(STATE, '', '[0,null]', NOW, 'phone', JSON.stringify({ other: 'application/pdf' }), () => new Uint8Array([1]).buffer);
    cloud.open = b.at; // A closed, B opened in its place
    release();
    await holding;
    expect(JSON.parse(await queued)).toMatchObject({ ok: false, reason: 'not-open' });
    expect(b.puts).toEqual([]);
    expect(cloud.commits).toEqual([]);
  });
});

describe('the iPhone Save checks for an erase before each original it writes, as the web does (US-11 AC1a)', () => {
  it('an erase landing after the first of two originals: the second is never written, and the answer is erased', async () => {
    const a = session('a');
    let erased = false;
    a.at.session.refuses = () => erased;
    // The erase lands as the first original's write finishes.
    a.at.host.store.writeDocument = async (ref: string) => { a.puts.push(ref); erased = true; };
    cloud.open = a.at;
    cloud.commits.length = 0;
    const file = (id: string) => ({ id, name: `${id}.pdf`, bytes: 1, hash: `sha256-${id}`, pages: { count: 1, truncated: false },
      status: { s: 'read', extraction: { ...letter, document: { ...letter.document, title: `Synthetic letter ${id}` } }, choices: NO_CHOICES } });
    const state = JSON.stringify({ ...JSON.parse(STATE), files: [file('one'), file('two')] });
    const answer = await uploadSaveRun(state, '', '[0,null]', NOW, 'phone', JSON.stringify({ one: 'application/pdf', two: 'application/pdf' }), () => new Uint8Array([1]).buffer);
    expect(JSON.parse(answer)).toMatchObject({ ok: false, reason: 'erased' });
    expect(a.puts).toHaveLength(1);
    expect(cloud.commits).toEqual([]);
  });

  // US-14 AC5, US-11 AC1a (2026-11-23): a busy refusal is tried again, and the engine asks `stopped` (this door's
  // `gone()`) before the retry. The control half proves the retry is reached: with no erase, the second try lands.
  it('on Dropbox: a busy refusal is retried; an erase landing before the retry stops it: one write, erased', async () => {
    vi.useFakeTimers();
    const run = async (eraseDuringWait: boolean) => {
      const a = session('a');
      let erased = false;
      let refusals = 1;
      a.at.session.refuses = () => erased;
      Object.assign(a.at.host.store, { id: 'dropbox' });
      a.at.host.store.writeDocument = async (ref: string) => {
        a.puts.push(ref);
        if (refusals-- <= 0) return;
        if (eraseDuringWait) setTimeout(() => { erased = true; }, 1);
        throw new BusyError('busy', 0, 409);
      };
      cloud.open = a.at;
      cloud.commits.length = 0;
      const answer = uploadSaveRun(STATE, '', '[0,null]', NOW, 'phone', JSON.stringify({ other: 'application/pdf' }), () => new Uint8Array([1]).buffer);
      await vi.runAllTimersAsync();
      return { answer: JSON.parse(await answer), puts: a.puts.length, commits: cloud.commits.length };
    };
    try {
      expect(await run(false)).toMatchObject({ answer: { ok: true, outcome: { unstored: 0 } }, puts: 2, commits: 1 });
      expect(await run(true)).toMatchObject({ answer: { ok: false, reason: 'erased' }, puts: 1, commits: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  // US-14 AC5 (2026-11-23): Dropbox makes a ref's folders in the write, so its writes pool from the first (no solo
  // round); the erase check before every write still holds there.
  it('on Dropbox: three originals start before any lands, and an erase landing mid-way stops every later write', async () => {
    const a = session('a');
    let erased = false;
    let landed = 0;
    let startedBeforeAnyLanded = 0;
    a.at.session.refuses = () => erased;
    Object.assign(a.at.host.store, { id: 'dropbox' });
    a.at.host.store.writeDocument = async (ref: string) => {
      a.puts.push(ref);
      if (landed === 0) startedBeforeAnyLanded = a.puts.length;
      await new Promise((r) => setTimeout(r, 1));
      landed += 1;
      if (landed === 4) erased = true; // the erase lands as the fourth original's write finishes
    };
    cloud.open = a.at;
    cloud.commits.length = 0;
    const ids = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    const file = (id: string) => ({ id, name: `${id}.pdf`, bytes: 1, hash: `sha256-${id}`, pages: { count: 1, truncated: false },
      status: { s: 'read', extraction: { ...letter, document: { ...letter.document, title: `Synthetic letter ${id}` } }, choices: NO_CHOICES } });
    const state = JSON.stringify({ ...JSON.parse(STATE), files: ids.map(file) });
    const answer = await uploadSaveRun(state, '', '[0,null]', NOW, 'phone', JSON.stringify(Object.fromEntries(ids.map((id) => [id, 'application/pdf']))), () => new Uint8Array([1]).buffer);
    expect(JSON.parse(answer)).toMatchObject({ ok: false, reason: 'erased' });
    expect(startedBeforeAnyLanded).toBe(3);
    // Four landed; the writes already in flight then finish, and none starts after the erase.
    expect(a.puts).toHaveLength(6);
    expect(cloud.commits).toEqual([]);
  });

  it('the session it began on closes after the first of two originals: the second is never written, and the answer is not-open', async () => {
    const a = session('a');
    // The session closes as the first original's write finishes.
    a.at.host.store.writeDocument = async (ref: string) => { a.puts.push(ref); cloud.open = null; };
    cloud.open = a.at;
    cloud.commits.length = 0;
    const file = (id: string) => ({ id, name: `${id}.pdf`, bytes: 1, hash: `sha256-${id}`, pages: { count: 1, truncated: false },
      status: { s: 'read', extraction: { ...letter, document: { ...letter.document, title: `Synthetic letter ${id}` } }, choices: NO_CHOICES } });
    const state = JSON.stringify({ ...JSON.parse(STATE), files: [file('one'), file('two')] });
    const answer = await uploadSaveRun(state, '', '[0,null]', NOW, 'phone', JSON.stringify({ one: 'application/pdf', two: 'application/pdf' }), () => new Uint8Array([1]).buffer);
    expect(JSON.parse(answer)).toMatchObject({ ok: false, reason: 'not-open' });
    expect(a.puts).toHaveLength(1);
    expect(cloud.commits).toEqual([]);
  });
});
