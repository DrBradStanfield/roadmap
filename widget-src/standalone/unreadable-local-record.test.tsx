// @vitest-environment jsdom
/**
 * US-65 AC7: a guest whose on-device record this build refuses (US-65 AC5)
 * sees why, instead of the loading skeleton forever, and the record is still
 * never written. Runs the real page entry (standalone/app.tsx, which the
 * Pages and Shopify builds share) on a seeded localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFile } from '@roadmap/health-core';

vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../src/lib/server-api', async (importOriginal) => ({ ...(await importOriginal<object>()), trackProductEvent: vi.fn() }));

const FILE_KEY = 'health_roadmap_file_v2';
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
    await import('./app');

    const root = document.getElementById('health-tool-root')!;
    await vi.waitFor(() => expect(root.textContent).toContain(message), { timeout: 5000 });
    expect(root.querySelector('.hr-skeleton')).toBeNull();
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(localStorage.getItem(FILE_KEY)).toBe(stored); // never written over
    await vi.waitFor(() => expect(rejections).toHaveLength(1));
  });

  it('a remembered cloud that cannot be reached falls back to that same device copy, and is explained too', async () => {
    // US-09 AC13's fallback runs on the device copy; when that copy is the
    // unreadable one, the fallback refuses as the guest load does.
    const stored = recordWith({ schemaVersion: 99 });
    localStorage.setItem(FILE_KEY, stored);
    localStorage.setItem('health_roadmap_backend', 'dropbox');
    localStorage.setItem('health_roadmap_dropbox_tokens', JSON.stringify({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3_600_000 }));
    await import('./app');

    const root = document.getElementById('health-tool-root')!;
    await vi.waitFor(() => expect(root.textContent).toContain('Update the app before writing, or your newer data could be lost.'), { timeout: 5000 });
    expect(localStorage.getItem(FILE_KEY)).toBe(stored);
    expect(vi.mocked(fetch)).toHaveBeenCalled(); // the cloud was tried first
  });
});
