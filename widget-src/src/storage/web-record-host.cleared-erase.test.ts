/**
 * @vitest-environment jsdom
 *
 * US-11 AC6 on the web: one localStorage key keeps the erase this browser's
 * off-file data (drafts, kept answers, stored originals) was last cleared for,
 * and the record it was cleared on: `{ lineage, erase }`, the store id and the
 * erase identity, nothing else. The host reads and writes it only while its
 * store owns that data (lib/storage ownsOffFileData), and reads it only for
 * its own store. Its clear reads back each key it removed, so a remove the
 * storage refused leaves the key where it was, and the next load clears again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import { createEmptyFile, createMeasurement } from '@roadmap/health-core/roadmap-file';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

/** The key's name, as the fix stores it (widget-src/src/lib/cleared-erase.ts). */
const CLEARED_KEY = 'health_roadmap_cleared_erase';
const BACKEND_KEY = 'health_roadmap_backend';
const VITALS_DRAFT_KEY = 'health_roadmap_vitals_draft';
const LPA_CHECK_KEPT_KEY = 'health_roadmap_lpa_check_kept';
const DOC_KEY = 'health_roadmap_doc_v2:Lab results/before.pdf';
const DRAFTS_CLEARED_EVENT = 'hr:drafts-cleared';
const ERASED = JSON.stringify([1, '2026-10-21T10:05:00.000Z']);

let webRecordHost: typeof import('./web-record-host').webRecordHost;
let LocalStorageAdapter: typeof import('./local-storage-adapter').LocalStorageAdapter;

// A fresh module graph is a fresh page: the owner rule reads the log-off id the page loaded with.
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem(BACKEND_KEY, 'memory'); // the cloud this browser chose (connect.ts rememberBackend)
  ({ webRecordHost } = await import('./web-record-host'));
  ({ LocalStorageAdapter } = await import('./local-storage-adapter'));
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const stored = () => {
  const raw = localStorage.getItem(CLEARED_KEY);
  return raw == null ? null : JSON.parse(raw);
};

/** A cloud record with one row, saved by a session on this device. */
async function savedRecord(cloud = new MemoryCloud()) {
  const session = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
  session.edit((file) => void file.measurements.push(createMeasurement({
    id: 'a', metricType: 'weight', value: 80, recordedAt: '2026-10-01', createdAt: '2026-10-21T10:00:00.000Z',
  })));
  await session.flush();
  return { cloud, session };
}

/** Another device's erase, written straight into the cloud record. */
function eraseAt(cloud: MemoryCloud, epoch: number, at: string) {
  const entry = cloud.files.get(ROADMAP_FILE_NAME)!;
  const file = JSON.parse(entry.json);
  Object.assign(file.meta, { eraseEpoch: epoch, erasedAt: at });
  file.measurements = [];
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: entry.version + 1 });
}
const eraseInCloud = (cloud: MemoryCloud) => eraseAt(cloud, 1, '2026-10-21T10:05:00.000Z');

function offFileData() {
  localStorage.setItem(VITALS_DRAFT_KEY, '{"draft":1}');
  localStorage.setItem(LPA_CHECK_KEPT_KEY, '["row"]');
  localStorage.setItem(DOC_KEY, 'data:application/pdf;base64,AAAA');
}
function offFileDataGone() {
  expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
  expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBeNull();
  expect(localStorage.getItem(DOC_KEY)).toBeNull();
}
function offFileDataKept() {
  expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBe('{"draft":1}');
  expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBe('["row"]');
  expect(localStorage.getItem(DOC_KEY)).not.toBeNull();
}

/** Every remove of `key` is refused, silently, as a storage that will not change may do. */
function refuseRemoving(key: string) {
  const remove = Storage.prototype.removeItem;
  return vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, k: string) {
    if (k === key) return;
    remove.call(this, k);
  });
}

describe('US-11 AC6: what the key holds', () => {
  it('after an owner writes it, it parses to exactly { lineage, erase }: the store id and [epoch, erasedAt]', async () => {
    const { cloud } = await savedRecord();
    expect(stored()).toEqual({ lineage: 'memory', erase: '[0,null]' });
    expect(Object.keys(stored()).sort()).toEqual(['erase', 'lineage']);

    eraseInCloud(cloud);
    await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect(stored()).toEqual({ lineage: 'memory', erase: ERASED });
    expect(Object.keys(stored()).sort()).toEqual(['erase', 'lineage']);
  });

  it('a host whose store is not the one chosen neither reads nor writes it', async () => {
    await savedRecord();
    localStorage.setItem(BACKEND_KEY, 'another-cloud');
    const host = webRecordHost(new MemoryAdapter(new MemoryCloud()));
    expect(host.clearedErase()).toBeNull();
    host.noteCleared(ERASED);
    expect(stored()).toEqual({ lineage: 'memory', erase: '[0,null]' });
  });

  it('a host on the chosen store reads none kept for another record', async () => {
    localStorage.setItem(CLEARED_KEY, JSON.stringify({ lineage: 'local', erase: ERASED }));
    expect(webRecordHost(new MemoryAdapter(new MemoryCloud())).clearedErase()).toBeNull();
  });
});

describe('US-11 AC6: a page closed through an erase made elsewhere, on the web', () => {
  it('the reload as owner clears the off-file data, then the key holds the new erase', async () => {
    const { cloud } = await savedRecord();
    offFileData();
    eraseInCloud(cloud);
    const session = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect(session.eraseIdentity).toBe(ERASED);
    offFileDataGone();
    expect(stored()).toEqual({ lineage: 'memory', erase: ERASED });
  });

  it('an existing browser with no key adopts the erased record\'s erase and clears nothing', async () => {
    const { cloud } = await savedRecord();
    eraseInCloud(cloud);
    localStorage.removeItem(CLEARED_KEY); // a browser from before the key
    offFileData();
    await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    offFileDataKept();
    expect(stored()).toEqual({ lineage: 'memory', erase: ERASED });
  });
});

describe('US-11 AC6: pages that do not own the off-file data, on the web', () => {
  it('a fallback page (a cloud chosen, the device record open) over an earlier key: no clear, the key unchanged', async () => {
    const { cloud } = await savedRecord();
    eraseInCloud(cloud);
    await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    localStorage.setItem(CLEARED_KEY, JSON.stringify({ lineage: 'memory', erase: ERASED })); // the earlier key, as that load leaves it
    const kept = stored();
    offFileData();
    const fallback = await RecordSession.open(webRecordHost(new LocalStorageAdapter()), { cloudUnreachable: true });
    expect(fallback.eraseIdentity).toBe('[0,null]');
    offFileDataKept();
    expect(stored()).toEqual(kept);
  });

  it('a page left on a cloud this browser moved away from takes an erase in: its on-screen draft is dropped, the stores and the key are unchanged', async () => {
    const { cloud, session } = await savedRecord();
    localStorage.setItem(CLEARED_KEY, JSON.stringify({ lineage: 'memory', erase: '[0,null]' })); // as that load leaves it
    const kept = stored();
    offFileData();
    localStorage.setItem(BACKEND_KEY, 'another-cloud'); // another tab switched
    eraseInCloud(cloud);
    const dropped = vi.fn();
    window.addEventListener(DRAFTS_CLEARED_EVENT, dropped);
    try {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-21T11:00:00.000Z')); // past the re-read throttle
      expect(await session.refreshFromRemote()).toBe(true);
    } finally {
      window.removeEventListener(DRAFTS_CLEARED_EVENT, dropped);
    }
    expect(dropped).toHaveBeenCalledTimes(1);
    offFileDataKept();
    expect(stored()).toEqual(kept);
  });
});

describe('US-11 AC6: a guest who signs in, on the web', () => {
  it('to an account erased before: adopts, clears nothing, and the key is { that cloud, its erase }', async () => {
    localStorage.removeItem(BACKEND_KEY); // a guest: the device record is the chosen one
    await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    expect(stored()).toEqual({ lineage: 'local', erase: '[0,null]' });
    offFileData();

    // The account, erased twice on another device before this sign-in.
    const account = new MemoryCloud();
    const file = createEmptyFile({ deviceId: 'dev_other', now: '2026-10-21T10:00:00.000Z' });
    Object.assign(file.meta, { eraseEpoch: 2, erasedAt: '2026-10-21T10:06:00.000Z' });
    account.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
    localStorage.setItem(BACKEND_KEY, 'memory'); // the sign-in
    vi.resetModules(); // which reloads the page
    ({ webRecordHost } = await import('./web-record-host'));

    const signedIn = await RecordSession.open(webRecordHost(new MemoryAdapter(account)));
    expect(signedIn.eraseIdentity).toBe(JSON.stringify([2, '2026-10-21T10:06:00.000Z']));
    offFileDataKept();
    expect(stored()).toEqual({ lineage: 'memory', erase: signedIn.eraseIdentity });
  });
});

describe('US-11 AC6: a clear whose read-back fails is tried again at the next load, on the web', () => {
  it('an erase made in this tab whose draft removal is refused leaves the key at the old erase; the next load clears, then moves it', async () => {
    const { cloud, session } = await savedRecord();
    expect(stored()).toEqual({ lineage: 'memory', erase: '[0,null]' });
    offFileData();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refusing = refuseRemoving(VITALS_DRAFT_KEY);
    const result = await session.erase();
    expect(result.success).toBe(true);
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).not.toBeNull();
    expect(stored()).toEqual({ lineage: 'memory', erase: '[0,null]' });

    refusing.mockRestore();
    const next = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect(next.eraseIdentity).toBe(session.eraseIdentity);
    offFileDataGone();
    expect(stored()).toEqual({ lineage: 'memory', erase: session.eraseIdentity });
  });

  it('the host\'s clear throws when a remove the storage refused left its key, and not when every key went', () => {
    const host = webRecordHost(new MemoryAdapter(new MemoryCloud()));
    offFileData();
    const refusing = refuseRemoving(VITALS_DRAFT_KEY);
    expect(() => host.clearOffFileData(new Set())).toThrow();
    refusing.mockRestore();
    localStorage.setItem('health_roadmap_doc_v2:kept.pdf', 'data:application/pdf;base64,BBBB');
    expect(() => host.clearOffFileData(new Set(['kept.pdf']))).not.toThrow();
    offFileDataGone();
    expect(localStorage.getItem('health_roadmap_doc_v2:kept.pdf')).not.toBeNull();
  });
});
