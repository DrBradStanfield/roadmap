// @vitest-environment jsdom
/**
 * Mount step 3a (US-52 AC8c, US-14 AC10, AC12, US-13 AC6, US-16 AC2a): `RoadmapStore.saveUpload`, the web's adapter
 * for the shared Save. Its originals are written first; then values, documents, the originals' rows and screening
 * dates land in ONE edit stamped with the erase the page showed when the Save began, or none of them does. A failed
 * original is reported as the store reports one, tags only, and counted unstored. A ZIP member's bytes are read only
 * as its original is written. Synthetic values and names, plain fake hashes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import type { UploadFile, UploadState } from '@roadmap/health-core/upload-flow';
import { reviewedWrites, uploadReview } from '@roadmap/health-core/upload-review';
import { Sentry } from '../lib/sentry';
import { emptyHeld, type Held } from '../lib/upload-read';
import { webUploadIO } from '../lib/upload-save-io';
import { RoadmapStore } from './roadmap-store';
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
  writes: string[] = [];
  reached: () => void = () => {};
  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    this.writes.push(bytes.type);
    this.reached();
    if (this.gate) await this.gate;
    if (this.fail) throw new Error('Synthetic test: the cloud refused it');
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
    const save = store.saveUpload(s, NOW, true, webUploadIO(held({ lab: pdf('lab'), letter: pdf('letter') })), PERSON);
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
    const answer = await store.saveUpload(saving(store, [read('lab', labX)]), NOW, true, webUploadIO(held({ lab: pdf('lab') })), PERSON);
    expect(answer).toEqual({ ok: false, reason: 'erased', message: 'Failed to save. Please try again.' });
    expect(adapter.writes).toEqual([]);
    expect(rowsOf(store)).toEqual({ labs: 0, documents: 0, stored: 0, screening: null });
  });

  it('an erase that lands while the originals upload refuses the commit: nothing of the upload is on the record, and no refused write is reported', async () => {
    const { adapter, store } = await opened();
    let release!: () => void;
    adapter.gate = new Promise((r) => { release = r; });
    const writing = new Promise<void>((r) => { adapter.reached = r; });
    const save = store.saveUpload(saving(store, [read('lab', labX), read('letter', letterX)]), NOW, true, webUploadIO(held({ lab: pdf('lab'), letter: pdf('letter') })), PERSON);
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

describe('US-14 AC12: a failed original is reported, tags only, and counted unstored', () => {
  it('each failed original is reported as the store reports one, and its row keeps the hash alone', async () => {
    const { adapter, store } = await opened();
    adapter.fail = true;
    const answer = await store.saveUpload(saving(store, [read('lab', labX), read('letter', letterX)]), NOW, true, webUploadIO(held({ lab: pdf('lab'), letter: pdf('letter') })), PERSON);
    expect(answer).toMatchObject({ ok: true, outcome: { values: 2, documents: 1, unstored: 2 } });
    expect(store.file.documents.map((d) => [d.contentHash, d.fileRef])).toEqual([['hash-letter', ''], ['hash-lab', '']]);
    const calls = vi.mocked(Sentry.captureException).mock.calls;
    expect(calls.map(([, hint]) => hint)).toEqual([0, 1].map(() => ({ tags: { area: 'cloud-sync', op: 'write-document', backend: 'memory' } })));
    // No name, title, value or hash in any report.
    expect(JSON.stringify(calls)).not.toMatch(/lab\.pdf|letter\.pdf|colonoscopy|hash-|2\.8|Ferritin/i);
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
    await store.saveUpload(s, NOW, false, io, PERSON);
    expect(member.async).not.toHaveBeenCalled();
    const { store: clouded } = await opened();
    await clouded.saveUpload(saving(clouded, files), NOW, true, io, PERSON);
    expect(member.async).toHaveBeenCalledTimes(1);
    expect(clouded.file.documents[0].fileRef).not.toBe('');
  });
});
