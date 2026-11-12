/**
 * US-09 AC45: log off removes every cloud provider's sign-in from this device.
 * The log-off id and the erase fence stay.
 *
 * Real connect.ts, adapters and storage; fakes only at Sentry, fetch and
 * reload. Synthetic entries with no real token shape; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
const ERASE_FENCE_KEY = 'health_roadmap_local_erase_generation';
const ENTRIES = {
  'google-drive': ['health_roadmap_gdrive', 'health_roadmap_gdrive_tokens'],
  dropbox: ['health_roadmap_dropbox_tokens'],
  github: ['health_roadmap_github'],
  'self-host': ['health_roadmap_selfhost'],
} as const;
type Cloud = keyof typeof ENTRIES;

function makeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  } as unknown as Storage;
}

let connect: typeof import('./connect');

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('localStorage', makeStorage());
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('location', { reload: vi.fn(), search: '', href: 'https://example.test/' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no network in this test'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  connect = await import('./connect');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A sign-in for every provider, saved under the current log-off id. */
function seedAll(gen: string): void {
  localStorage.setItem(LOG_OFF_ID_KEY, gen);
  localStorage.setItem(ERASE_FENCE_KEY, 'fence-1');
  for (const keys of Object.values(ENTRIES)) {
    for (const key of keys) localStorage.setItem(key, JSON.stringify({ accessToken: 'test-token-good', gen }));
  }
}

describe('US-09 AC45: log off removes every provider sign-in on this device', () => {
  const others = (active: Cloud) => (Object.keys(ENTRIES) as Cloud[]).filter((b) => b !== active);

  for (const active of ['google-drive', 'dropbox', 'github', 'self-host'] as const) {
    for (const left of others(active)) {
      it(`after a log-off from ${active}, no ${left} sign-in remains`, async () => {
        seedAll('gen-1');
        localStorage.setItem('health_roadmap_backend', active);
        await connect.logOff(active);
        for (const key of ENTRIES[left]) expect(localStorage.getItem(key)).toBeNull();
        for (const key of ENTRIES[active]) expect(localStorage.getItem(key)).toBeNull();
      });
    }
  }

  it('US-11 AC6: log-off removes the erase this browser last cleared its off-file data for', async () => {
    seedAll('gen-1');
    localStorage.setItem('health_roadmap_backend', 'dropbox');
    localStorage.setItem('health_roadmap_cleared_erase', JSON.stringify({ lineage: 'dropbox', erase: '[1,"2026-10-21T10:05:00.000Z"]' }));
    await connect.logOff('dropbox');
    expect(localStorage.getItem('health_roadmap_cleared_erase')).toBeNull();
  });

  it('after a log-off from the device-only tier, no provider sign-in remains', async () => {
    seedAll('gen-1');
    await connect.logOff('local');
    for (const keys of Object.values(ENTRIES)) for (const key of keys) expect(localStorage.getItem(key)).toBeNull();
  });

  it('when the active provider fails to disconnect, no provider sign-in remains', async () => {
    seedAll('gen-1');
    const { GoogleDriveAdapter } = await import('../src/storage/drive');
    vi.spyOn(GoogleDriveAdapter.prototype, 'disconnect').mockRejectedValue(new Error('synthetic disconnect failure'));
    await connect.logOff('google-drive');
    for (const keys of Object.values(ENTRIES)) for (const key of keys) expect(localStorage.getItem(key)).toBeNull();
  });

  it('the sign-in sweep never names the log-off id or the erase fence, and the id is new', async () => {
    const { SIGN_IN_KEYS } = await import('./providers');
    expect(SIGN_IN_KEYS).not.toContain(LOG_OFF_ID_KEY);
    expect(SIGN_IN_KEYS).not.toContain(ERASE_FENCE_KEY);
    seedAll('gen-1');
    await connect.logOff('google-drive');
    const id = localStorage.getItem(LOG_OFF_ID_KEY);
    expect(id).not.toBeNull();
    expect(id).not.toBe('gen-1');
  });
});
