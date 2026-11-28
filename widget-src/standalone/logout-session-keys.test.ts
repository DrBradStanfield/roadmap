// @vitest-environment jsdom
/**
 * US-09 AC68: log-off also removes the chat's guest session and a connect's
 * lift record, so the next person on this browser starts with neither. The
 * reminders switch marker (US-17 AC12) and the assistant key stay. Real
 * connect.ts and storage; fakes only at Sentry, the event sender and fetch.
 * Synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const CLEARED = ['health_roadmap_guest_session', 'health_roadmap_lifted_revision'];

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no network in this test'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('US-09 AC68: log-off clears the chat session and lift keys', () => {
  it.each(['dropbox', 'local'] as const)('removes both after a log-off from %s; the switch marker and assistant key stay', async (backend) => {
    for (const key of CLEARED) localStorage.setItem(key, 'test-value');
    localStorage.setItem('health_roadmap_backend', backend);
    localStorage.setItem('hr_reminders_switch_cancelled', 'test-token-kept');
    localStorage.setItem('hr_anthropic_key', 'test-key-kept');
    const connect = await import('./connect');
    await connect.logOff(backend);
    expect(CLEARED.filter((key) => localStorage.getItem(key) !== null)).toEqual([]);
    expect(localStorage.getItem('hr_reminders_switch_cancelled')).toBe('test-token-kept'); // US-17 AC12
    expect(localStorage.getItem('hr_anthropic_key')).toBe('test-key-kept'); // kept: see AC68
  });
});
