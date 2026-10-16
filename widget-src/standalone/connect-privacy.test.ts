import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFile, ROADMAP_FILE_NAME } from '@roadmap/health-core';
import { LocalStorageAdapter } from '../src/storage';
import { WebDavAdapter } from '../src/storage/webdav';
import { liftLocalInto } from './connect';
import { Sentry, scrubEvent } from '../src/lib/sentry';
import { EXPECTED_NETWORK_ERRORS } from '../src/lib/error-diagnostics';

function lastCapture() {
  const [error, options] = vi.mocked(Sentry.captureException).mock.calls.at(-1)!;
  return { error: error as Error, tags: (options as { tags: Record<string, string> }).tags };
}

vi.mock('../src/lib/sentry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/sentry')>(),
  Sentry: { captureException: vi.fn() },
}));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

async function seedDevice() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const file = createEmptyFile({ deviceId: 'synthetic', now: '2026-01-01T00:00:00.000Z' });
  await new LocalStorageAdapter().write(ROADMAP_FILE_NAME, file, null);
}
// All HTTP is stubbed; no actual provider or credential is used.
const adapter = () => new WebDavAdapter({ url: 'https://fixture.invalid/', username: 'unused', password: 'unused' });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('US-09 AC6b: the connect-time lift has the storage privacy boundary', () => {
  it('normalizes an expected offline interruption to the SDK ignore patterns', async () => {
    await seedDevice();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await liftLocalInto(adapter(), 'self-host');
    const { error } = lastCapture();
    expect(error.message).toBe('Network request did not answer');
    expect(EXPECTED_NETWORK_ERRORS.some(pattern => pattern.test(error.message))).toBe(true);
    expect(localStorage.getItem('health_roadmap_pending_cloud_sync')).not.toBeNull();
  });
  it('reports a fixed failure without provider prose, cause or raw console arguments', async () => {
    await seedDevice();
    const privateText = 'Synthetic Person appointment.pdf';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(privateText, { status: 500 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await liftLocalInto(adapter(), 'self-host');
    const { error, tags } = lastCapture();
    expect(error.message).toBe('Cloud sync failed');
    expect('cause' in error).toBe(false);
    expect(tags).toEqual({ area: 'cloud-sync', op: 'migrate-up', backend: 'self-host' });
    expect(warn.mock.calls).toEqual([['Guest-data lift on connect failed']]);
    expect(localStorage.getItem('health_roadmap_pending_cloud_sync')).not.toBeNull();

    // Exercise the real beforeSend hook, not a mock of the privacy control.
    const event = scrubEvent({
      type: undefined,
      tags,
      exception: { values: [{ type: 'Error', value: error.message }] },
      extra: { providerReply: privateText },
      contexts: { provider: { detail: privateText } },
      breadcrumbs: [{ category: 'custom', message: privateText }],
      request: { url: 'https://fixture.invalid/synthetic-document' },
    });
    expect(event?.tags).toEqual({ area: 'cloud-sync', op: 'migrate-up', backend: 'self-host' });
    expect(event?.exception?.values?.[0].value).toBe('Health record operation failed');
    expect(event?.extra).toBeUndefined();
    expect(event?.contexts).toBeUndefined();
    expect(event?.breadcrumbs).toBeUndefined();
    expect(event?.request).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(privateText);
  });
});
