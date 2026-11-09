// @vitest-environment jsdom
/**
 * US-65 AC7: a guest whose on-device record this build refuses (US-65 AC5)
 * sees why, instead of the loading skeleton forever, and the record is still
 * never written. Runs the real page entry (standalone/app.tsx, which the
 * Pages and Shopify builds share) on a seeded localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFile } from '@roadmap/health-core/roadmap-file';

type Core = typeof import('@roadmap/health-core/adapter');

vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../src/lib/server-api', async (importOriginal) => ({ ...(await importOriginal<object>()), trackProductEvent: vi.fn() }));

const FILE_KEY = 'health_roadmap_file_v2';
const REV_KEY = 'health_roadmap_file_v2_rev';
const REV = '7-synthetic';
const SKELETON = '<div class="hr-skeleton" aria-hidden="true">synthetic skeleton</div>';

function recordWith(change: Record<string, unknown>): string {
  return JSON.stringify({ ...createEmptyFile({ deviceId: 'synthetic-device', now: '2026-01-01T00:00:00.000Z' }), ...change });
}

const UNREADABLE: Array<[string, string, string]> = [
  ['a newer schemaVersion', recordWith({ schemaVersion: 99 }), 'Update the app before writing, or your newer data could be lost.'],
  ['truncated JSON', '{"schemaVersion":1,"meta":', 'Local data is corrupt and could not be read.'],
  ['a value that is not a record', '[]', 'Not a health-roadmap.json'],
  ['one wrongly typed row list', recordWith({ labValues: 'oops' }), 'its labValues is not a list'],
];

let rejections: unknown[];
let vitestHandlers: NodeJS.UnhandledRejectionListener[];
const keepRejection = (reason: unknown) => void rejections.push(reason);

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = `<div id="health-tool-root">${SKELETON}</div>`;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network forbidden in this test'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The refusal still rejects main(), as before, so the page's global handler
  // still sees it; hold it here so the run does not count it as a test error.
  rejections = [];
  vitestHandlers = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', keepRejection);
});

afterEach(() => {
  process.removeListener('unhandledRejection', keepRejection);
  for (const handler of vitestHandlers) process.on('unhandledRejection', handler);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('US-65 AC7: an on-device record the app refuses at load is explained, not a stuck skeleton', () => {
  it.each(UNREADABLE)('%s shows the refusal and leaves the stored bytes alone', async (_label, stored, message) => {
    localStorage.setItem(FILE_KEY, stored);
    localStorage.setItem(REV_KEY, REV);
    await import('./app');

    const root = document.getElementById('health-tool-root')!;
    await vi.waitFor(() => expect(root.textContent).toContain(message), { timeout: 5000 });
    expect(root.querySelector('.hr-skeleton')).toBeNull();
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    // In the ErrorBoundary's markup: its class, own heading, the refusal's words, and the report link.
    const panel = root.querySelector('.health-tool-error[role="alert"]');
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('h3')?.textContent).toBe('Your saved record could not be opened');
    expect(panel!.querySelector('p')?.textContent).toContain(message);
    // A refusal is not fixed by a reload, so the panel does not suggest one.
    expect(panel!.textContent).not.toContain('Reload the page');
    const report = panel!.querySelector('a');
    expect(report?.textContent).toBe('Report this issue');
    expect(report?.getAttribute('href')).toBe('mailto:brad@drstanfield.com?subject=Health%20Roadmap%20Bug%20Report');
    expect(report?.parentElement?.tagName).toBe('P');
    expect(report?.parentElement?.style.marginTop).toBe('8px');
    expect(report?.parentElement?.style.fontSize).toBe('14px');
    // The record and its revision are never written over.
    expect(localStorage.getItem(FILE_KEY)).toBe(stored);
    expect(localStorage.getItem(REV_KEY)).toBe(REV);
    // main() still rejects, and with the refusal itself, not a later error.
    await vi.waitFor(() => expect(rejections).toHaveLength(1));
    expect((rejections[0] as Error).message).toContain(message);
  });

  it('a page without the mount point draws nothing and main() still rejects with the refusal itself', async () => {
    document.body.innerHTML = '';
    localStorage.setItem(FILE_KEY, recordWith({ schemaVersion: 99 }));
    localStorage.setItem(REV_KEY, REV);
    await import('./app');
    await vi.waitFor(() => expect(rejections).toHaveLength(1), { timeout: 5000 });
    expect((rejections[0] as Error).name).toBe('SchemaTooNewError');
    expect(document.body.innerHTML).toBe('');
  });

  it('a remembered cloud that cannot be reached falls back to that same device copy, and is explained too', async () => {
    // US-09 AC13's fallback runs on the device copy; when that copy is the
    // unreadable one, the fallback refuses as the guest load does.
    const stored = recordWith({ schemaVersion: 99 });
    localStorage.setItem(FILE_KEY, stored);
    localStorage.setItem(REV_KEY, REV);
    localStorage.setItem('health_roadmap_backend', 'dropbox');
    localStorage.setItem('health_roadmap_dropbox_tokens', JSON.stringify({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3_600_000 }));
    await import('./app');

    const root = document.getElementById('health-tool-root')!;
    await vi.waitFor(() => expect(root.textContent).toContain('Update the app before writing, or your newer data could be lost.'), { timeout: 5000 });
    expect(localStorage.getItem(FILE_KEY)).toBe(stored);
    expect(localStorage.getItem(REV_KEY)).toBe(REV);
    expect(vi.mocked(fetch)).toHaveBeenCalled(); // the cloud was tried first
    await vi.waitFor(() => expect(rejections).toHaveLength(1));
    expect((rejections[0] as Error).name).toBe('SchemaTooNewError');
  });

  it.each([
    ['a version mismatch', (core: Core) => new core.ConflictError('expected version 3, but local is 4'), 'expected version 3, but local is 4'],
    ['a full device store', (core: Core) => new core.StorageError('Could not save on this device (local storage may be full).'), 'local storage may be full'],
  ])('%s at load is a storage failure, not a refusal: a neutral heading and a reload line', async (_label, failure, message) => {
    // The record itself may be fine, so the page must not say it is broken.
    // Built from the page's own copy of health-core (resetModules gives it a fresh one), so its class checks hold.
    let error: Error | undefined;
    vi.doMock('../src/lib/roadmap-data', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      initRoadmapStore: async () => { throw (error = failure(await import('@roadmap/health-core/adapter'))); },
    }));
    try {
      await import('./app');
      const root = document.getElementById('health-tool-root')!;
      await vi.waitFor(() => expect(root.textContent).toContain(message), { timeout: 5000 });
      const panel = root.querySelector('.health-tool-error[role="alert"]')!;
      expect(panel.querySelector('h3')?.textContent).toBe('Your saved record did not load');
      expect([...panel.querySelectorAll('p')].map(p => p.textContent)).toEqual([error!.message, 'Reload the page to try again.', 'Report this issue']);
      expect(panel.querySelector('a')?.getAttribute('href')).toBe('mailto:brad@drstanfield.com?subject=Health%20Roadmap%20Bug%20Report');
      await vi.waitFor(() => expect(rejections).toHaveLength(1));
      expect(rejections[0]).toBe(error);
    } finally {
      vi.doUnmock('../src/lib/roadmap-data');
    }
  });

  it('a startup error that is not a storage failure shows no panel and still rejects', async () => {
    // AC7's stated limit: only a storage failure is named on the page. A bug
    // elsewhere must not tell the person their record is bad.
    const bug = new TypeError('synthetic bug');
    vi.doMock('../src/lib/roadmap-data', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      initRoadmapStore: async () => { throw bug; },
    }));
    try {
      await import('./app');
      await vi.waitFor(() => expect(rejections).toHaveLength(1), { timeout: 5000 });
      expect(rejections[0]).toBe(bug);
      const root = document.getElementById('health-tool-root')!;
      expect(root.textContent).toBe('synthetic skeleton');
      expect(root.querySelector('[role="alert"]')).toBeNull();
    } finally {
      vi.doUnmock('../src/lib/roadmap-data');
    }
  });
});
