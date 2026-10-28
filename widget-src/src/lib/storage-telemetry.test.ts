// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventFiltersIntegration, linkedErrorsIntegration, type Client, type Event } from '@sentry/core';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { ConflictError, MemoryAdapter, StorageError } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage';
import { stopRoadmapLocalWrites } from '../storage/local-storage-adapter';
import { Sentry, scrubEvent } from './sentry';
import { EXPECTED_NETWORK_ERRORS, recordFailure, storageCauseClass, storageFailureClass } from './error-diagnostics';

// US-09 AC6: provider errors and request breadcrumbs may contain document
// titles or results. Inspect complete outgoing SDK envelopes, not just extras.
const marker = 'PHI_SENTINEL';
let envelopes: unknown[];

beforeEach(() => {
  envelopes = [];
  vi.stubGlobal('crypto', webcrypto);
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.init({
    dsn: 'https://public@example.invalid/1',
    defaultIntegrations: [linkedErrorsIntegration(), eventFiltersIntegration()],
    ignoreErrors: EXPECTED_NETWORK_ERRORS,
    beforeSend: scrubEvent,
    transport: () => ({
      send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
});

afterEach(async () => {
  await Sentry.close();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('cloud-storage telemetry boundary', () => {
  it('does not expose a rejected archive reference in console or Sentry', async () => {
    class FailingArchive extends MemoryAdapter {
      async writeDocument(): Promise<void> {
        throw new StorageError(`Clinic letters/${marker} synthetic result.pdf`, undefined, new Error(marker), 503);
      }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await RoadmapStore.create(new FailingArchive());
    Sentry.addBreadcrumb({ category: 'fetch', data: { url: `https://storage.example/${marker}.pdf` } });
    await store.bulkSaveDocuments([{
      documentType: 'clinic_letter', title: marker, documentDate: '2026-01-01',
      contentMd: marker, metadata: {}, sourceFileName: `${marker}.pdf`,
      file: new NodeBlob(['synthetic pdf'], { type: 'application/pdf' }) as unknown as Blob,
    }]);
    await store.flush();
    await Sentry.flush();
    expect(envelopes.length).toBeGreaterThan(0);
    expect(JSON.stringify(envelopes)).not.toContain(marker);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
    expect(JSON.stringify(envelopes)).toContain('write-document');
  });

  it('scrubs older cloud-sync captures, including causes and request URLs', async () => {
    Sentry.addBreadcrumb({ category: 'console', message: marker, data: { arguments: [marker] } });
    Sentry.captureException(Object.assign(new Error(marker), { cause: new Error(marker) }), {
      tags: { area: 'cloud-sync', op: 'copy-down', backend: 'google-drive' },
      extra: { providerBody: marker },
      contexts: { storage: { path: marker } },
    });
    await Sentry.flush();
    expect(envelopes).toHaveLength(1);
    expect(JSON.stringify(envelopes)).not.toContain(marker);
    expect(JSON.stringify(envelopes)).toContain('copy-down');
    const [, items] = envelopes[0] as [unknown, Array<[unknown, { exception: { values: unknown[] } }]>];
    expect(items[0][1].exception.values).toHaveLength(2);
  });

  it("keeps the browser's failure class of a device persist failure, never its message (US-09 AC16)", async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new DOMException(marker, 'QuotaExceededError'); },
      removeItem: () => {},
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z');
    await expect(store.flush()).rejects.toThrow('still on this device');
    await Sentry.flush();
    const [, items] = envelopes[0] as [unknown, Array<[unknown, { tags: Record<string, string> }]>];
    expect(items[0][1].tags).toEqual({
      area: 'cloud-sync', op: 'persist', backend: 'local', cause: 'QuotaExceededError', errorClass: 'StorageError', causeClass: 'DOMException',
    });
    expect(JSON.stringify(envelopes)).not.toContain(marker);
  });

  it('names no cause on a cloud persist failure — that is the transport, not the device', async () => {
    class DeadCloud extends MemoryAdapter {
      async write(): Promise<never> { throw new TypeError(`${marker} is not a function`); } // a defect, not a transport interruption
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await RoadmapStore.create(new DeadCloud());
    store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z');
    await expect(store.flush()).rejects.toThrow('still on this device');
    await Sentry.flush();
    const [, items] = envelopes[0] as [unknown, Array<[unknown, { tags: Record<string, string> }]>];
    expect(items[0][1].tags).toEqual({ area: 'cloud-sync', op: 'persist', backend: 'memory', errorClass: 'other', causeClass: 'none' });
  });

  it.each([
    [new StorageError(marker, undefined, new DOMException(marker, 'SecurityError')), 'SecurityError'],
    [new StorageError(marker, undefined, new TypeError(marker)), 'TypeError'],
    [new StorageError(marker, undefined, new ReferenceError(marker)), 'ReferenceError'],
    [new StorageError(marker, undefined, new Error(marker)), 'other'],
    [new TypeError('Failed to fetch'), 'other'], // a bare transport error is not a storage class
    [marker, 'other'],
  ])('names the failure class from a closed list: %s → %s', (error, expected) => {
    expect(storageFailureClass(error)).toBe(expected);
  });

  // US-09 AC28 (Sentry JAVASCRIPT-REMIX-77): cause=other pooled every device
  // refusal the browser did not name. The persist capture now says which
  // class of error it was and what a StorageError wrapped, each from a
  // closed list, so a corrupt read, a conflict and an odd refusal read apart.
  it.each([
    [new StorageError(marker, undefined, new SyntaxError(marker)), 'SyntaxError'],
    [new StorageError(marker, undefined, new ConflictError(marker)), 'ConflictError'],
    [new StorageError(marker), 'none'],
    [new StorageError(marker, undefined, new DOMException(marker, 'NS_ERROR_FILE_CORRUPTED')), 'DOMException'],
    [new StorageError(marker, undefined, new DOMException(marker, 'QuotaExceededError')), 'DOMException'],
    [new StorageError(marker, undefined, new DOMException(marker, 'SyntaxError')), 'DOMException'], // not instanceof SyntaxError
    [new StorageError(marker, undefined, new StorageError(marker)), 'StorageError'], // AC29: a failure after the write landed
    [new StorageError(marker, undefined, new Error(marker)), 'other'],
    [new StorageError(marker, undefined, marker), 'other'],
    [new SyntaxError(marker), 'none'], // only a StorageError's own cause is read
  ])('names the cause class from a closed list (US-09 AC28): %s → %s', (error, expected) => {
    expect(storageCauseClass(error)).toBe(expected);
  });

  it.each([
    [new StorageError(marker, undefined, new SyntaxError(marker)), 'SyntaxError'],
    [new StorageError(marker, undefined, new ConflictError(marker)), 'ConflictError'],
    [new StorageError(marker), 'none'],
    [new StorageError(marker, undefined, new RangeError(marker)), 'other'],
  ])('tags a persist failure with its error and cause class, never its text (US-09 AC28): %s → %s', async (error, causeClass) => {
    class RefusingCloud extends MemoryAdapter {
      async write(): Promise<never> { throw error; }
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await RoadmapStore.create(new RefusingCloud());
    store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z');
    await expect(store.flush()).rejects.toThrow('still on this device');
    await Sentry.flush();
    const [, items] = envelopes[0] as [unknown, Array<[unknown, { tags: Record<string, string> }]>];
    expect(items[0][1].tags).toEqual({ area: 'cloud-sync', op: 'persist', backend: 'memory', errorClass: 'StorageError', causeClass });
    expect(JSON.stringify(envelopes)).not.toContain(marker);
  });

  // US-09 AC28, as the device tier really throws (backend=local, where 77
  // fires). A failure after a write has landed is wrapped again by the save,
  // so its cause is a StorageError and reads `other`; a lost-update storm
  // keeps its last LostUpdateError (a ConflictError) as the cause.
  describe('the device tier, end to end (US-09 AC28)', () => {
    const FILE_KEY = 'health_roadmap_file_v2';
    const setItem = Storage.prototype.setItem;
    const getItem = Storage.prototype.getItem;

    async function persistTags(arrange: (store: RoadmapStore) => Promise<void> | void): Promise<Record<string, string>> {
      localStorage.clear();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = await RoadmapStore.create(new LocalStorageAdapter());
      store.addMeasurement('weight', 82, '2024-06-01T09:00:00.000Z');
      await store.flush();
      await arrange(store);
      store.addMeasurement('ldl', 4.5, '2024-06-02T09:00:00.000Z');
      await expect(store.flush()).rejects.toThrow();
      await Sentry.flush();
      expect(envelopes).toHaveLength(1);
      const [, items] = envelopes[0] as [unknown, Array<[unknown, { tags: Record<string, string> }]>];
      return items[0][1].tags;
    }
    const local = { area: 'cloud-sync', op: 'persist', backend: 'local', cause: 'other', errorClass: 'StorageError' };

    it('a corrupt file read before the write reads SyntaxError', async () => {
      expect(await persistTags(() => { localStorage.setItem(FILE_KEY, `{${marker}`); })).toEqual({ ...local, causeClass: 'SyntaxError' });
    });

    it('a corrupt read-back after the write landed reads StorageError (wrapped again by the save, US-09 AC29)', async () => {
      let armed = false;
      let written = false;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
        if (armed && key === FILE_KEY) written = true;
        setItem.call(this, key, value);
      });
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        return written && key === FILE_KEY ? `{${marker}` : getItem.call(this, key);
      });
      expect(await persistTags(() => { armed = true; })).toEqual({ ...local, causeClass: 'StorageError' });
    });

    it('a refused write with an unlisted browser name reads DOMException, not the marker (US-09 AC29)', async () => {
      let armed = false;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
        if (armed && key === FILE_KEY) throw new DOMException(marker, 'NS_ERROR_FILE_CORRUPTED');
        setItem.call(this, key, value);
      });
      expect(await persistTags(() => { armed = true; })).toEqual({ ...local, causeClass: 'DOMException' });
      expect(JSON.stringify(envelopes)).not.toContain(marker);
    });

    it('a write that never lands (verify reads an older revision every time) reads ConflictError', async () => {
      let frozen = false;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
        if (!(frozen && key === FILE_KEY)) setItem.call(this, key, value);
      });
      expect(await persistTags(() => { frozen = true; })).toEqual({ ...local, causeClass: 'ConflictError' });
    });

    // Last on purpose: the logout latch is page-lifetime module state with no
    // reset, so no device-tier save in this file may run after it.
    it('a write refused for logout reads none', async () => {
      expect(await persistTags(() => stopRoadmapLocalWrites())).toEqual({ ...local, causeClass: 'none' });
    });
  });

  it('keeps a closed cause class through the scrub and drops any other value (US-09 AC28)', () => {
    for (const causeClass of ['SyntaxError', 'ConflictError', 'StorageError', 'DOMException', 'none', 'other']) {
      const tags = { area: 'cloud-sync', op: 'persist', backend: 'local', errorClass: 'StorageError', causeClass };
      expect(scrubEvent({ type: undefined, tags })!.tags).toEqual(tags);
    }
    const tags = { area: 'cloud-sync', op: 'persist', backend: 'local', causeClass: marker };
    expect(scrubEvent({ type: undefined, tags })!.tags).toEqual({ area: 'cloud-sync', op: 'persist', backend: 'local' });
  });

  it('keeps the load operation of a startup fallback capture (US-09 AC13)', () => {
    const tags = { area: 'cloud-sync', op: 'load', backend: 'google-drive' };
    expect(scrubEvent({ type: undefined, tags })!.tags).toEqual(tags);
  });

  it('still admits a sanitized current-bundle event through the real SDK filter', () => {
    const event = {
      type: undefined,
      tags: { area: 'cloud-sync', op: 'write-document', backend: 'dropbox' },
      request: { url: `https://storage.example/${marker}.pdf`, data: marker },
      exception: { values: [{ type: 'StorageError', value: marker, stacktrace: { frames: [{
        filename: 'https://cdn.shopify.com/extensions/test/assets/health-plan-v2.js', lineno: 1,
      }] } }] },
    };
    const scrubbed = scrubEvent(event)!;
    const filter = eventFiltersIntegration();
    const client = { getOptions: () => ({ allowUrls: [/health-plan-v2\.js$/] }) } as Client;
    expect(filter.processEvent!(scrubbed as Event, {}, client)).not.toBeNull();
    expect(JSON.stringify(scrubbed)).not.toContain(marker);
  });

  it.each(['cloud-sync', 'upload-save', 'upload'])('removes record content from the %s capture shape', area => {
    const scrubbed = scrubEvent({
      type: undefined,
      tags: area === 'upload' ? { feature: area, uploadErrorCode: 'network' } : { area },
      message: marker, extra: { fileTypes: [marker], value: marker },
      exception: { values: [{ value: marker }] },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(marker);
  });

  it('prevents storage request paths reaching an unrelated later event', async () => {
    Sentry.addBreadcrumb({ category: 'console', message: marker, data: { arguments: [marker] } });
    for (const url of [
      `https://api.github.com/repos/owner/repo/contents/${marker}.pdf`,
      `https://www.googleapis.com/drive/v3/files?q=${marker}`,
      `https://my-webdav.example/${marker}.pdf`,
    ]) Sentry.addBreadcrumb({ category: 'fetch', data: { url, method: 'GET', status_code: 503 } });
    Sentry.captureException(new Error('Unrelated UI error'));
    await Sentry.flush();
    expect(JSON.stringify(envelopes)).not.toContain(marker);
    expect(JSON.stringify(envelopes)).toContain('api.github.com');
    expect(JSON.stringify(envelopes)).toContain('503');
  });

  it.each(['Dropbox did not answer', 'Failed to fetch', 'Load failed', 'The operation was aborted'])('keeps %s suppressed after constructing a safe exception', async message => {
    Sentry.captureException(recordFailure(new Error(`${message}: ${marker}`), 'Cloud sync failed'), {
      tags: { area: 'cloud-sync', op: 'persist', backend: 'dropbox' },
    });
    await Sentry.flush();
    expect(envelopes).toEqual([]);
  });
});
