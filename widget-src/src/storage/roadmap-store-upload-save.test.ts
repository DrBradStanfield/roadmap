// @vitest-environment jsdom
/**
 * Mount step 3a (US-52 AC8c, US-14 AC10, AC12, US-13 AC6, US-16 AC2a): `RoadmapStore.saveUpload`, the web's adapter
 * for the shared Save. Its originals are written first; then values, documents, the originals' rows and screening
 * dates land in ONE edit stamped with the erase the page showed when the Save began, or none of them does. A failed
 * original is reported as the store reports one, tags only, and counted unstored. A ZIP member's bytes are read only
 * as its original is written. Synthetic values and names, plain fake hashes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusyError } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import type { UploadFile, UploadState } from '@roadmap/health-core/upload-flow';
import { reviewedWrites, uploadReview } from '@roadmap/health-core/upload-review';
import { uploadSave } from '@roadmap/health-core/upload-save';
import { Sentry } from '../lib/sentry';
import { emptyHeld, type Held } from '../lib/upload-read';
import { webUploadIO } from '../lib/upload-save-io';
import { RoadmapStore } from './roadmap-store';
import { stamped } from '../testing/upload-save-kit';
import { BACKEND_KEY } from './web-record-host';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const NOW = new Date().toISOString();
const labX: UnifiedExtractionResult = {
  classification: 'lab_report', reportDate: '2025-09-02', unrecognized: [], document: null,
  values: [{ metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
  additionalValues: [{ name: 'Ferritin', value: 90, unit: 'µg/L' }],
};
const letterX: UnifiedExtractionResult = {
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title: 'Synthetic colonoscopy', documentDate: '2025-06-12', contentMarkdown: 'Synthetic', metadata: { screeningType: 'colorectal' } },
};
const read = (id: string, x: UnifiedExtractionResult, more: Partial<UploadFile> = {}): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 9, hash: `hash-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction: x, choices: NO_CHOICES }, ...more });
const PERSON = { age: 55, sex: 'female' as const };
const ENGINE = { uploadSave, uploadReview };

/** The pick as Save starts it on `store`'s record: the reviewed page's writes echoed, as the flow sends them. */
function saving(store: RoadmapStore, files: UploadFile[]): UploadState {
  const open: UploadState = { phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW };
  return { ...open, phase: 'saving', attempt: 1, reviewed: reviewedWrites(uploadReview(open, store.file, NOW)) };
}
const held = (files: Record<string, File | { async(t: 'blob'): Promise<Blob> }>): Held => {
  const h = emptyHeld(1);
  for (const [id, f] of Object.entries(files)) h.files.set(id, f instanceof File ? { file: f } : { entry: f });
  return h;
};
const pdf = (id: string) => new File([`bytes of ${id}`], `${id}.pdf`, { type: 'application/pdf' });

/** A cloud whose original writes wait for `release`, or fail. */
class GatedCloud extends MemoryAdapter {
  gate: Promise<void> | null = null;
  fail = false;
  /** Writes still to refuse as busy (Dropbox's folder lock). */
  busy = 0;
  writes: string[] = [];
  reached: () => void = () => {};
  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    this.writes.push(bytes.type);
    this.reached();
    if (this.gate) await this.gate;
    if (this.fail) throw new Error('Synthetic test: the cloud refused it');
    if (this.busy > 0 && this.busy--) throw new BusyError('Synthetic test: busy', 0, 409);
    return super.writeDocument(ref, bytes);
  }
}

beforeEach(() => { localStorage.clear(); localStorage.setItem(BACKEND_KEY, 'memory'); });
afterEach(() => { vi.mocked(Sentry.captureException).mockClear(); });

async function opened() {
  const cloud = new MemoryCloud();
  const adapter = new GatedCloud(cloud);
  const store = await RoadmapStore.create(adapter);
  store.showErase(store.eraseIdentity);
  return { cloud, adapter, store };
}
const rowsOf = (store: RoadmapStore) => ({
  labs: store.file.labValues.length, documents: store.file.documents.filter((d) => !d.deleted).length,
  stored: store.file.documents.filter((d) => d.fileRef).length, screening: store.file.screenings.colorectalLastDate ?? null,
});

describe('US-52 AC8c, US-16 AC2a: one Save, one edit', () => {
  it('values, documents, originals\' rows and the screening date land together, after the originals are written', async () => {
    const { adapter, store } = await opened();
    let release!: () => void;
    adapter.gate = new Promise((r) => { release = r; });
    const writing = new Promise<void>((r) => { adapter.reached = r; });
    const s = saving(store, [read('lab', labX), read('letter', letterX)]);
    const save = store.saveUpload(ENGINE, stamped(s, store.shownErase), NOW, true, webUploadIO(held({ lab: pdf('lab'), letter: pdf('letter') })), PERSON);
    await writing;
    expect(rowsOf(store)).toEqual({ labs: 0, documents: 0, stored: 0, screening: null });
    release();
    const answer = await save;
    expect(answer).toMatchObject({ ok: true, outcome: { values: 2, documents: 1, unstored: 0, screenings: 1 } });
    expect(rowsOf(store)).toEqual({ labs: 2, documents: 2, stored: 2, screening: '2025-06-12' });
    expect(adapter.writes).toEqual(['application/pdf', 'application/pdf']);
  });

  it('a Save the page began before an erase it no longer shows is refused before any original is written', async () => {
    const { adapter, store } = await opened();
    store.showErase('[0,"an erase the page showed"]');
    const answer = await store.saveUpload(ENGINE, stamped(saving(store, [read('lab', labX)]), store.shownErase), NOW, true, webUploadIO(held({ lab: pdf('lab') })), PERSON);
    expect(answer).toEqual({ ok: false, reason: 'erased', message: 'Failed to save. Please try again.' });
    expect(adapter.writes).toEqual([]);
    expect(rowsOf(store)).toEqual({ labs: 0, documents: 0, stored: 0, screening: null });
  });

  it('an erase that lands while the originals upload refuses the commit: nothing of the upload is on the record, and no refused write is reported', async () => {
    const { adapter, store } = await opened();
    let release!: () => void;
    adapter.gate = new Promise((r) => { release = r; });
    const writing = new Promise<void>((r) => { adapter.reached = r; });
    const save = store.saveUpload(ENGINE, stamped(saving(store, [read('lab', labX), read('letter', letterX)]), store.shownErase), NOW, true, webUploadIO(held({ lab: pdf('lab'), letter: pdf('letter') })), PERSON);
    await writing;
    adapter.gate = null;
    const erased = await store.deleteAllData();
    expect(erased.success).toBe(true);
    release();
    expect(await save).toEqual({ ok: false, reason: 'erased', message: 'Failed to save. Please try again.' });
    expect(rowsOf(store)).toEqual({ labs: 0, documents: 0, stored: 0, screening: null });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

// US-16 AC2a (lead H18, H19): the Save stands for the erase its saving state carries, the one the page showed at the
// press on Save (hooks/useUploadFlow.ts `save`), not the one the page shows when the Save runs.
describe('US-16 AC2a: the Save writes under the erase its state carries', () => {
  async function erasedAfterThePress() {
    const { adapter, store } = await opened();
    const pressed = store.shownErase;
    const s = { ...saving(store, [read('lab', labX), read('letter', letterX)]), erase: pressed } as UploadState;
    expect((await store.deleteAllData()).success).toBe(true);
    store.showErase(store.eraseIdentity); // the page has drawn the erased record since the press
    await store.flush();
    return { adapter, store, s };
  }
  const io = () => webUploadIO(held({ lab: pdf('lab'), letter: pdf('letter') }));

  it('pressed before an erase the page now shows: refused, no original written, the record unchanged', async () => {
    const { adapter, store, s } = await erasedAfterThePress();
    const before = JSON.stringify(store.file);
    expect(await store.saveUpload(ENGINE, stamped(s, store.shownErase), NOW, true, io(), PERSON)).toEqual({ ok: false, reason: 'erased', message: 'Failed to save. Please try again.' });
    expect(adapter.writes).toEqual([]);
    expect(JSON.stringify(store.file)).toBe(before);
  });

  it('control: pressed under the erase shown, the same Save lands', async () => {
    const { store, s } = await erasedAfterThePress();
    const answer = await store.saveUpload(ENGINE, stamped({ ...s, erase: store.shownErase } as UploadState, store.shownErase), NOW, true, io(), PERSON);
    expect(answer).toMatchObject({ ok: true, outcome: { values: 2, documents: 1 } });
    expect(rowsOf(store)).toMatchObject({ labs: 2, documents: 2 });
  });
});

describe('US-14 AC12: a failed original is reported, tags only, and counted unstored', () => {
  it('each failed original is reported as the store reports one, and its row keeps the hash alone', async () => {
    const { adapter, store } = await opened();
    adapter.fail = true;
    const answer = await store.saveUpload(ENGINE, stamped(saving(store, [read('lab', labX), read('letter', letterX)]), store.shownErase), NOW, true, webUploadIO(held({ lab: pdf('lab'), letter: pdf('letter') })), PERSON);
    expect(answer).toMatchObject({ ok: true, outcome: { values: 2, documents: 1, unstored: 2 } });
    expect(store.file.documents.map((d) => [d.contentHash, d.fileRef])).toEqual([['hash-letter', ''], ['hash-lab', '']]);
    const calls = vi.mocked(Sentry.captureException).mock.calls;
    expect(calls.map(([, hint]) => hint)).toEqual([0, 1].map(() => ({ tags: { area: 'cloud-sync', op: 'write-document', backend: 'memory' } })));
    // No name, title, value or hash in any report.
    expect(JSON.stringify(calls)).not.toMatch(/lab\.pdf|letter\.pdf|colonoscopy|hash-|2\.8|Ferritin/i);
  });
});

// US-14 AC5 (2026-11-23): a busy refusal is counted under its own tag, never as "not stored" unless it never lands.
describe('US-14 AC5: a busy refusal is reported on its own', () => {
  const BUSY = { tags: { area: 'cloud-sync', op: 'write-document-busy', backend: 'memory' } };
  const NOT_STORED = { tags: { area: 'cloud-sync', op: 'write-document', backend: 'memory' } };
  async function saveLetter(busy: number) {
    const { adapter, store } = await opened();
    adapter.busy = busy;
    let inflated = 0;
    // A ZIP member: its bytes are read (inflated) only as its original is written.
    const member = { async: async () => { inflated += 1; return new Blob(['bytes of letter'], { type: 'application/pdf' }); } };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const answer = store.saveUpload(ENGINE, stamped(saving(store, [read('letter', letterX)]), store.shownErase), NOW, true, webUploadIO(held({ letter: member })), PERSON);
      await vi.runAllTimersAsync();
      return { answer: await answer, inflated, writes: adapter.writes.length, reports: vi.mocked(Sentry.captureException).mock.calls.map(([, hint]) => hint) };
    } finally {
      vi.useRealTimers();
    }
  }

  it('refused once, then stored: one busy report, no "not stored" report, the bytes read once', async () => {
    const { answer, reports, inflated, writes } = await saveLetter(1);
    expect(answer).toMatchObject({ ok: true, outcome: { documents: 1, unstored: 0 } });
    expect(reports).toEqual([BUSY]);
    expect({ inflated, writes }).toEqual({ inflated: 1, writes: 2 });
  });

  it('refused on every try: one busy report for the original, and exactly one "not stored"', async () => {
    const { answer, reports, writes } = await saveLetter(99);
    expect(answer).toMatchObject({ ok: true, outcome: { documents: 1, unstored: 1 } });
    expect(writes).toBe(3);
    expect(reports).toEqual([BUSY, NOT_STORED]);
    expect(JSON.stringify(vi.mocked(Sentry.captureException).mock.calls)).not.toMatch(/letter\.pdf|colonoscopy|hash-/i);
  });
});

// US-14 AC5 (2026-11-23): the bytes kept for a busy retry are held only while that original is in flight: freed when it
// settles, stored or not (a third refusal, a stop), so a busy Dropbox never holds more than the three lanes' bytes.
describe('US-14 AC5: bytes kept for a retry are freed when the original settles', () => {
  /** Every Blob held as a Map value right now, and the most at once. */
  function heldBlobs() {
    // An array, not a Map: the spies below watch every Map.
    const live: Array<{ map: Map<unknown, unknown>; keys: Set<unknown> }> = [];
    let peak = 0;
    const count = () => live.reduce((n, e) => n + e.keys.size, 0);
    const keysOf = (map: Map<unknown, unknown>) => live.find((e) => e.map === map)?.keys ?? live[live.push({ map, keys: new Set() }) - 1].keys;
    const set = Map.prototype.set;
    const del = Map.prototype.delete;
    vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (v instanceof Blob) keysOf(this).add(k); else live.find((e) => e.map === this)?.keys.delete(k);
      peak = Math.max(peak, count());
      return set.call(this, k, v);
    });
    vi.spyOn(Map.prototype, 'delete').mockImplementation(function (this: Map<unknown, unknown>, k: unknown) {
      live.find((e) => e.map === this)?.keys.delete(k);
      return del.call(this, k);
    });
    return { now: count, peak: () => peak };
  }
  const members = (ids: string[]) => held(Object.fromEntries(ids.map((id) => [id, { async: async () => new Blob([`bytes of ${id}`], { type: 'application/pdf' }) }])));
  const letters = (ids: string[]) => ids.map((id) => read(id, { ...letterX, document: { ...letterX.document!, title: `Synthetic letter ${id}` } }));

  it('five originals refused to exhaustion: never more than three held at once, none once each settles', async () => {
    const { adapter, store } = await opened();
    adapter.busy = 99;
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const s = saving(store, letters(ids));
    const blobs = heldBlobs();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const answer = store.saveUpload(ENGINE, stamped(s, store.shownErase), NOW, true, webUploadIO(members(ids)), PERSON);
      await vi.runAllTimersAsync();
      expect(await answer).toMatchObject({ ok: true, outcome: { unstored: 5 } });
    } finally {
      vi.useRealTimers();
      vi.mocked(Map.prototype.set).mockRestore();
      vi.mocked(Map.prototype.delete).mockRestore();
    }
    expect(adapter.writes).toHaveLength(15);
    expect(blobs.peak()).toBeLessThanOrEqual(3);
    expect(blobs.now()).toBe(0);
  });

  it('an original stopped by an erase after a busy refusal: its bytes are freed too', async () => {
    const { adapter, store } = await opened();
    adapter.busy = 99;
    let erasing: Promise<unknown> | null = null;
    // The erase lands during the retry's wait, after the refusal kept the bytes.
    adapter.reached = () => { setTimeout(() => { erasing ??= store.deleteAllData(); }, 1); };
    const s = saving(store, letters(['a']));
    const blobs = heldBlobs();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const answer = store.saveUpload(ENGINE, stamped(s, store.shownErase), NOW, true, webUploadIO(members(['a'])), PERSON);
      await vi.runAllTimersAsync();
      expect(await answer).toMatchObject({ ok: false, reason: 'erased' });
      await erasing;
    } finally {
      vi.useRealTimers();
      vi.mocked(Map.prototype.set).mockRestore();
      vi.mocked(Map.prototype.delete).mockRestore();
    }
    expect(adapter.writes).toHaveLength(1);
    expect(blobs.now()).toBe(0);
  });
});

describe('US-16 AC2a: no write starts after an erase', () => {
  it('an erase that lands while a ZIP member inflates: its original is never sent', async () => {
    const { adapter, store } = await opened();
    let inflate!: (b: Blob) => void;
    let asked!: () => void;
    const reading = new Promise<void>((r) => { asked = r; });
    const member = { async: () => { asked(); return new Promise<Blob>((r) => { inflate = r; }); } };
    const save = store.saveUpload(ENGINE, stamped(saving(store, [read('zip/0', labX, { zip: 'bundle.zip', name: 'member.pdf' })]), store.shownErase), NOW, true, webUploadIO(held({ 'zip/0': member })), PERSON);
    await reading;
    expect((await store.deleteAllData()).success).toBe(true);
    inflate(new Blob(['bytes of member']));
    expect(await save).toEqual({ ok: false, reason: 'erased', message: 'Failed to save. Please try again.' });
    expect(adapter.writes).toEqual([]);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('US-14 AC12: an original that cannot be read is counted unstored and reported as a read, not as the cloud\'s refusal', () => {
  it('a ZIP member that will not inflate: no cloud write, one upload-save report, the row keeps the hash', async () => {
    const { adapter, store } = await opened();
    const member = { async: () => Promise.reject(new Error('Synthetic test: the member would not inflate')) };
    const answer = await store.saveUpload(ENGINE, stamped(saving(store, [read('zip/0', labX, { zip: 'bundle.zip', name: 'member.pdf' })]), store.shownErase), NOW, true, webUploadIO(held({ 'zip/0': member })), PERSON);
    expect(answer).toMatchObject({ ok: true, outcome: { values: 2, unstored: 1 } });
    expect(adapter.writes).toEqual([]);
    expect(vi.mocked(Sentry.captureException).mock.calls.map(([, hint]) => hint)).toEqual([{ tags: { area: 'upload-save', branch: 'original' } }]);
    expect(store.file.documents.map((d) => [d.contentHash, d.fileRef])).toEqual([['hash-zip/0', '']]);
  });
});

describe('US-12 AC23: a ZIP member\'s original is inflated only as it is written', () => {
  it('the member is read once, at its write, and never with no cloud', async () => {
    const { store } = await opened();
    const member = { async: vi.fn(async () => new Blob(['bytes of member'])) };
    const files = [read('zip/0', labX, { zip: 'bundle.zip', name: 'member.pdf' })];
    const s = saving(store, files);
    const io = webUploadIO(held({ 'zip/0': member }));
    expect(io.holds('zip/0')).toBe(true);
    expect(member.async).not.toHaveBeenCalled();
    await store.saveUpload(ENGINE, stamped(s, store.shownErase), NOW, false, io, PERSON);
    expect(member.async).not.toHaveBeenCalled();
    const { store: clouded } = await opened();
    await clouded.saveUpload(ENGINE, stamped(saving(clouded, files), clouded.shownErase), NOW, true, io, PERSON);
    expect(member.async).toHaveBeenCalledTimes(1);
    expect(clouded.file.documents[0].fileRef).not.toBe('');
  });
});
