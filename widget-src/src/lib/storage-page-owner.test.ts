// @vitest-environment jsdom
/**
 * US-11 AC6 — the page's own record, as the owner rule reads it for the matrix
 * drafts (pageOwnsOffFileData): the device record on the device tier, the
 * cloud whose record opened last on a cloud, and none while the page loads.
 * Each test is a fresh page (a fresh module graph). Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const BACKEND_KEY = 'health_roadmap_backend';

async function loadPage() {
  vi.resetModules();
  const storage = await import('./storage');
  const { webRecordHost } = await import('../storage/web-record-host');
  const { LocalStorageAdapter } = await import('../storage/local-storage-adapter');
  /** A cloud adapter named `id`, as each provider's adapter is. */
  const cloud = (id: string) => Object.defineProperty(new MemoryAdapter(new MemoryCloud()), 'id', { value: id });
  return { ...storage, webRecordHost, device: () => new LocalStorageAdapter(), cloud };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('US-11 AC6 — which record the page is on, for its drafts', () => {
  it('a page still loading owns nothing, whatever the browser has chosen', async () => {
    const page = await loadPage();
    expect(page.pageOwnsOffFileData()).toBe(false);
    localStorage.setItem(BACKEND_KEY, 'memory');
    expect(page.pageOwnsOffFileData()).toBe(false);
  });

  it('two cloud hosts in a row (the OAuth return: the lift, then the store) end on the store\'s record', async () => {
    const page = await loadPage();
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    page.webRecordHost(page.cloud('memory')).mirror!.opened(); // the lift
    expect(page.pageOwnsOffFileData()).toBe(false);
    page.webRecordHost(page.cloud('google-drive')).mirror!.opened(); // the store

    expect(page.pageOwnsOffFileData()).toBe(true);
    localStorage.setItem(BACKEND_KEY, 'memory');
    expect(page.pageOwnsOffFileData()).toBe(false);
  });

  it('a guest that connects without a reload is on the cloud\'s record from then on', async () => {
    const page = await loadPage();
    page.webRecordHost(page.device());
    expect(page.pageOwnsOffFileData()).toBe(true);

    localStorage.setItem(BACKEND_KEY, 'memory');
    expect(page.pageOwnsOffFileData()).toBe(false); // chosen, not yet open here
    page.webRecordHost(page.cloud('memory')).mirror!.opened();

    expect(page.pageOwnsOffFileData()).toBe(true);
    localStorage.removeItem(BACKEND_KEY); // the device record chosen again
    expect(page.pageOwnsOffFileData()).toBe(false);
  });
});
