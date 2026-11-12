/**
 * US-09 AC45: log off removes every cloud provider's sign-in from this device,
 * not only the one in use. The log-off id and the erase fence stay.
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

/** Every provider's entries, saved under the current log-off id. */
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
      it(`a ${left} entry left from earlier is gone after a log-off from ${active}`, async () => {
        seedAll('gen-1');
        localStorage.setItem('health_roadmap_backend', active);
        await connect.logOff(active);
        for (const key of ENTRIES[left]) expect(localStorage.getItem(key)).toBeNull();
        for (const key of ENTRIES[active]) expect(localStorage.getItem(key)).toBeNull();
      });
    }
  }

  it('a log-off on the device-only tier removes every provider entry too', async () => {
    seedAll('gen-1');
    await connect.logOff('local');
    for (const keys of Object.values(ENTRIES)) for (const key of keys) expect(localStorage.getItem(key)).toBeNull();
  });

  it('the log-off id and the erase fence survive, and the id is new', async () => {
    seedAll('gen-1');
    await connect.logOff('google-drive');
    const id = localStorage.getItem(LOG_OFF_ID_KEY);
    expect(id).not.toBeNull();
    expect(id).not.toBe('gen-1');
    expect(localStorage.getItem(ERASE_FENCE_KEY)).not.toBeNull();
  });
});
