// @vitest-environment jsdom
/**
 * US-09 AC68: log-off also removes the chat's guest session, a connect's
 * lift record and a Pages user's Anthropic key, so the next person on this
 * browser starts with none. The reminders switch marker (US-17 AC12) stays. Real
 * connect.ts, storage and byok-chat's key gate; fakes only at Sentry, the event
 * sender and fetch.
 * Synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
// The Pages build's swap (vite.config.standalone.ts): the chat gate is byok-chat's.
vi.mock('../src/lib/chat-api', async (original) => ({
  ...(await original<typeof import('../src/lib/chat-api')>()),
  getChatGate: (await import('../src/lib/byok-chat')).getChatGate,
}));

const CLEARED = ['health_roadmap_guest_session', 'health_roadmap_lifted_revision', 'hr_anthropic_key'];

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no network in this test'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('US-09 AC68: log-off clears the chat session, lift and assistant keys', () => {
  it.each(['dropbox', 'local'] as const)('removes all three after a log-off from %s; the switch marker stays', async (backend) => {
    for (const key of CLEARED) localStorage.setItem(key, 'test-value');
    localStorage.setItem('health_roadmap_backend', backend);
    localStorage.setItem('hr_reminders_switch_cancelled', 'test-token-kept');
    const connect = await import('./connect');
    await connect.logOff(backend);
    expect(CLEARED.filter((key) => localStorage.getItem(key) !== null)).toEqual([]);
    expect(localStorage.getItem('hr_reminders_switch_cancelled')).toBe('test-token-kept'); // US-17 AC12
  });
});
