import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError, createEmptyFile, LostUpdateError, MemoryAdapter, RecordShapeError, ROADMAP_FILE_NAME,
  SchemaTooNewError, StorageError,
} from '@roadmap/health-core';
import { LocalStorageAdapter } from '../src/storage';
import { WebDavAdapter } from '../src/storage/webdav';
import { liftLocalInto, migrateLocalInto, prepareSwitch, reportConnectFailure } from './connect';
import { Sentry, scrubEvent } from '../src/lib/sentry';
import { ERROR_CLASS_TAGS, EXPECTED_NETWORK_ERRORS, failureTags, HTTP_STATUS_TAGS } from '../src/lib/error-diagnostics';

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
    // WebDAV names no status on its error, so the status class is `none` (US-09 AC6c).
    const expected = { area: 'cloud-sync', op: 'migrate-up', backend: 'self-host', errorClass: 'StorageError', httpStatus: 'none' };
    expect(tags).toEqual(expected);
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
    expect(event?.tags).toEqual(expected);
    expect(event?.exception?.values?.[0].value).toBe('Health record operation failed');
    expect(event?.extra).toBeUndefined();
    expect(event?.contexts).toBeUndefined();
    expect(event?.breadcrumbs).toBeUndefined();
    expect(event?.request).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(privateText);
  });
});

// Synthetic only: no real person, provider or credential.
const privateText = 'Synthetic Person lipids.pdf';
const warnSpy = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
const strictEvent = (error: Error, tags: Record<string, string>) => scrubEvent({
  type: undefined,
  tags,
  exception: { values: [{ type: 'Error', value: error.message }] },
  extra: { providerReply: privateText },
  breadcrumbs: [{ category: 'custom', message: privateText }],
});

describe('US-09 AC6c: connect diagnostics are closed-list tags and fixed text', () => {
  it('names the error class and the HTTP status class from closed lists only', () => {
    expect(ERROR_CLASS_TAGS).toEqual(['StorageError', 'ConflictError', 'SchemaTooNewError', 'RecordShapeError', 'other']);
    expect(HTTP_STATUS_TAGS).toEqual(['401', '403', '404', '409', '429', '4xx', '5xx', 'none']);
    const status = (code?: number) => new StorageError(privateText, undefined, undefined, code);
    const cases: Array<[unknown, string, string]> = [
      [status(401), 'StorageError', '401'], [status(403), 'StorageError', '403'],
      [status(404), 'StorageError', '404'], [status(409), 'StorageError', '409'],
      [status(429), 'StorageError', '429'], [status(400), 'StorageError', '4xx'],
      [status(500), 'StorageError', '5xx'], [status(503), 'StorageError', '5xx'],
      [status(302), 'StorageError', 'none'], [status(), 'StorageError', 'none'],
      [new ConflictError(), 'ConflictError', 'none'], [new LostUpdateError(privateText), 'ConflictError', 'none'],
      [new SchemaTooNewError(9, 1), 'SchemaTooNewError', 'none'], [new RecordShapeError(privateText), 'RecordShapeError', 'none'],
      [new TypeError('Failed to fetch'), 'other', 'none'], [privateText, 'other', 'none'],
      // Only a StorageError's own status counts; a status on any other object is not read.
      [Object.assign(new Error(privateText), { status: 403 }), 'other', 'none'],
    ];
    for (const [error, errorClass, httpStatus] of cases) {
      expect(failureTags(error), String(error)).toEqual({ errorClass, httpStatus });
    }
  });

  it('tags a refused lift with its class and status, and the envelope keeps both', async () => {
    await seedDevice();
    class Refusing extends MemoryAdapter {
      async read(): Promise<never> { throw new StorageError(privateText, undefined, undefined, 403); }
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await liftLocalInto(new Refusing(), 'google-drive');
    const { error, tags } = lastCapture();
    const expected = { area: 'cloud-sync', op: 'migrate-up', backend: 'google-drive', errorClass: 'StorageError', httpStatus: '403' };
    expect(tags).toEqual(expected);
    const event = strictEvent(error, tags);
    expect(event?.tags).toEqual(expected);
    expect(JSON.stringify(event)).not.toContain(privateText);
  });

  it('the envelope drops a class or status tag that is not on its list', () => {
    const event = strictEvent(new Error('Cloud sync failed'), {
      area: 'cloud-sync', op: 'migrate-up', errorClass: privateText, httpStatus: '403 Synthetic Person',
    });
    expect(event?.tags).toEqual({ area: 'cloud-sync', op: 'migrate-up' });
  });

  it('an OAuth-return failure goes out as a fixed message under the strict envelope', () => {
    const warn = warnSpy();
    reportConnectFailure(new StorageError(`Dropbox token exchange failed (400): ${privateText}`), 'dropbox');
    const { error, tags } = lastCapture();
    expect(error.message).toBe('Cloud connect failed');
    expect('cause' in error).toBe(false);
    const expected = { area: 'cloud-connect', backend: 'dropbox', errorClass: 'StorageError', httpStatus: 'none' };
    expect(tags).toEqual(expected);
    expect(warn.mock.calls).toEqual([['Dropbox connect failed']]);
    const event = strictEvent(error, tags);
    expect(event?.tags).toEqual(expected);
    expect(event?.exception?.values?.[0].value).toBe('Health record operation failed');
    expect(event?.extra).toBeUndefined();
    expect(event?.breadcrumbs).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(privateText);
  });

  it('an offline OAuth return is normalized to the SDK ignore patterns', () => {
    warnSpy();
    reportConnectFailure(new TypeError('Failed to fetch'), 'google-drive');
    const { error, tags } = lastCapture();
    expect(EXPECTED_NETWORK_ERRORS.some(pattern => pattern.test(error.message))).toBe(true);
    expect(tags).toEqual({ area: 'cloud-connect', backend: 'google-drive', errorClass: 'other', httpStatus: 'none' });
  });

  it('app.tsx reports both OAuth returns through reportConnectFailure, never raw', () => {
    const source = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Sentry\.captureException/);
    expect(source).not.toMatch(/console\.\w+\([^)]*\berror\b/);
    expect(source.match(/reportConnectFailure\(error, '(dropbox|google-drive)'\)/g)).toHaveLength(2);
  });
});

describe('US-09 AC6c: local console lines are fixed, never the raw error', () => {
  it('an unreadable device file', async () => {
    await seedDevice();
    localStorage.setItem('health_roadmap_file_v2', `{not json ${privateText}`);
    const warn = warnSpy();
    await migrateLocalInto(adapter());
    expect(warn.mock.calls).toEqual([['On-device data unreadable — connecting without the lift']]);
  });

  it('a failed disconnect at log-off', async () => {
    await seedDevice();
    // A real log-off ends the page. Give its irreversible write barrier a
    // fresh module graph, rather than carrying it into the next test's page.
    vi.resetModules();
    const { logOff: pageLogOff } = await import('./connect');
    const { WebDavAdapter: PageWebDavAdapter } = await import('../src/storage/webdav');
    vi.stubGlobal('location', { reload: vi.fn() });
    vi.spyOn(PageWebDavAdapter.prototype, 'disconnect').mockRejectedValue(new Error(privateText));
    const warn = warnSpy();
    await pageLogOff('self-host');
    expect(warn.mock.calls).toContainEqual(['Cloud disconnect during log-off failed']);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
  });

  it('a failed copy-down before a switch', async () => {
    await seedDevice();
    vi.spyOn(WebDavAdapter.prototype, 'read').mockRejectedValue(new Error(privateText));
    const warn = warnSpy();
    await expect(prepareSwitch('self-host')).rejects.toThrow(/could not be reached/);
    expect(warn.mock.calls).toEqual([['Copy-down before switch failed']]);
  });
});
