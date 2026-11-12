/**
 * @vitest-environment jsdom
 *
 * US-11 AC6 on the web: localStorage keeps the erase this device's off-file
 * data was last cleared for (`health_roadmap_cleared_erase`). The host's clear
 * reads back each key it removed, so a remove the storage refused leaves the
 * clear owed and the key unwritten, and the next load clears again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import { createMeasurement } from '@roadmap/health-core/roadmap-file';
import { webRecordHost } from './web-record-host';
import { DOC_KEY_PREFIX, LPA_CHECK_KEPT_KEY, VITALS_DRAFT_KEY } from '../lib/storage';
import { Sentry } from '../lib/sentry';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const CLEARED_KEY = 'health_roadmap_cleared_erase';
const ERASED = JSON.stringify([1, '2026-10-21T10:05:00.000Z']);

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(Sentry.captureException).mockClear();
});

/** A cloud record with one row, saved by a session on this device. */
async function savedRecord() {
  const cloud = new MemoryCloud();
  const session = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
  session.edit((file) => void file.measurements.push(createMeasurement({
    id: 'a', metricType: 'weight', value: 80, recordedAt: '2026-10-01', createdAt: '2026-10-21T10:00:00.000Z',
  })));
  await session.flush();
  return cloud;
}

/** Another device's erase, written straight into the cloud record. */
function eraseInCloud(cloud: MemoryCloud) {
  const entry = cloud.files.get(ROADMAP_FILE_NAME)!;
  const file = JSON.parse(entry.json);
  file.meta.eraseEpoch = 1;
  file.meta.erasedAt = '2026-10-21T10:05:00.000Z';
  file.measurements = [];
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: entry.version + 1 });
}

function offFileData() {
  localStorage.setItem(VITALS_DRAFT_KEY, '{"draft":1}');
  localStorage.setItem(LPA_CHECK_KEPT_KEY, '["row"]');
  localStorage.setItem(`${DOC_KEY_PREFIX}Lab results/before.pdf`, 'data:application/pdf;base64,AAAA');
}

function offFileDataGone() {
  expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
  expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBeNull();
  expect(localStorage.getItem(`${DOC_KEY_PREFIX}Lab results/before.pdf`)).toBeNull();
}

describe('webRecordHost: the erase last cleared for', () => {
  it('reads and writes one localStorage key, holding the erase identity only', () => {
    const host = webRecordHost(new MemoryAdapter(new MemoryCloud()));
    expect(host.clearedErase()).toBeNull();
    host.noteCleared(ERASED);
    expect(localStorage.getItem(CLEARED_KEY)).toBe(ERASED);
    expect(host.clearedErase()).toBe(ERASED);
  });

  it('a clear throws when a remove the storage refused silently left its key', () => {
    const host = webRecordHost(new MemoryAdapter(new MemoryCloud()));
    offFileData();
    const remove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (key === VITALS_DRAFT_KEY) throw new DOMException('refused', 'SecurityError');
      remove.call(this, key);
    });
    expect(() => host.clearOffFileData(new Set())).toThrow();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).not.toBeNull();
  });

  it('a clear that removes every key does not throw, and keeps the originals it was told to keep', () => {
    const host = webRecordHost(new MemoryAdapter(new MemoryCloud()));
    offFileData();
    localStorage.setItem(`${DOC_KEY_PREFIX}kept.pdf`, 'data:application/pdf;base64,BBBB');
    host.clearOffFileData(new Set(['kept.pdf']));
    offFileDataGone();
    expect(localStorage.getItem(`${DOC_KEY_PREFIX}kept.pdf`)).not.toBeNull();
  });
});

describe('US-11 AC6: a load after another device\'s erase, on the web', () => {
  it('clears the off-file data and writes the erase it cleared for', async () => {
    const cloud = await savedRecord();
    expect(localStorage.getItem(CLEARED_KEY)).toBe('[0,null]');
    offFileData();
    eraseInCloud(cloud);
    const session = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect(session.eraseIdentity).toBe(ERASED);
    offFileDataGone();
    expect(localStorage.getItem(CLEARED_KEY)).toBe(ERASED);
  });

  it('a remove the storage refuses silently leaves the clear owed and the key unwritten; the next load clears', async () => {
    const cloud = await savedRecord();
    offFileData();
    eraseInCloud(cloud);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const remove = Storage.prototype.removeItem;
    const refusing = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (key === VITALS_DRAFT_KEY) throw new DOMException('refused', 'SecurityError');
      remove.call(this, key);
    });
    await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).not.toBeNull();
    expect(localStorage.getItem(CLEARED_KEY)).toBe('[0,null]');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    refusing.mockRestore();
    await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    offFileDataGone();
    expect(localStorage.getItem(CLEARED_KEY)).toBe(ERASED);
  });
});

describe('US-11 AC6: the mark a connect leaves, on the web', () => {
  it('a fallback first load leaves the mark; the cloud load adopts the erased record and keeps the drafts', async () => {
    const cloud = await savedRecord();
    eraseInCloud(cloud);
    localStorage.setItem(CLEARED_KEY, 'adopt');
    offFileData();
    await RecordSession.open(webRecordHost(new MemoryAdapter(new MemoryCloud())), { cloudUnreachable: true });
    expect(localStorage.getItem(CLEARED_KEY)).toBe('adopt');

    const session = await RecordSession.open(webRecordHost(new MemoryAdapter(cloud)));
    expect(session.eraseIdentity).toBe(ERASED);
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBe('{"draft":1}');
    expect(localStorage.getItem(CLEARED_KEY)).toBe(ERASED);
  });
});
