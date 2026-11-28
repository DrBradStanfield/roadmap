// @vitest-environment jsdom
/**
 * US-09 AC67: log-off removes the once-a-day keys of the cloud id count, so a
 * sign-in after the log-off is measured the same day. Real connect.ts and
 * storage; fakes only at Sentry, the event sender and fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no network in this test'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('US-09 AC67: log-off clears the cloud id day keys', () => {
  it('removes every provider day key and leaves other keys alone', async () => {
    const day = new Date().toISOString().slice(0, 10);
    for (const p of ['google-drive', 'dropbox', 'github']) localStorage.setItem(`hr_cloud_identity_day_${p}`, day);
    localStorage.setItem('health_roadmap_backend', 'dropbox');
    localStorage.setItem('hr_vid', '5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e');
    const connect = await import('./connect');
    await connect.logOff('dropbox');
    expect(Object.keys(localStorage).filter((k) => k.startsWith('hr_cloud_identity_day_'))).toEqual([]);
    expect(localStorage.getItem('hr_vid')).toBe('5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e');
  });
});
