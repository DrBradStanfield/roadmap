// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventFiltersIntegration, linkedErrorsIntegration, type Client, type Event } from '@sentry/core';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { MemoryAdapter, StorageError } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { Sentry, scrubEvent } from './sentry';
import { EXPECTED_NETWORK_ERRORS, recordFailure } from './error-diagnostics';

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
