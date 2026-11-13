// @vitest-environment jsdom
/**
 * Untangle fix 4, PR 2b-2 (the erase machine wired into useErase): the pins
 * this PR adds at the page. The PR 1221 pins (HealthTool.erase-event-pins)
 * and the other erase pages run unedited beside them.
 *
 * Loop safety rests on the first: a refused save re-reads (Q3: every refused
 * save while an erase is heard), so a re-read that asked a save of its own,
 * refused in turn, would re-read again, without end.
 *
 * The whole widget over a REAL RoadmapStore on jsdom's localStorage.
 * Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { migrateFile } from '@roadmap/health-core/migrate';
import { rowRootIds } from '@roadmap/health-core/merge';
import { CURRENT_SCHEMA_VERSION } from '@roadmap/health-core/roadmap-file';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { getEraseIdentity, getShownErase } from '../lib/roadmap-data';
import { WRITE_REFUSED } from '../lib/erase-copy';
import { openAboutYou, seedGuest, useHealthToolLifecycle, trackLiveRefresh, stopLiveRefresh, drain, settle } from '../testing/health-tool-harness';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));

import { HealthTool } from './HealthTool';

const FILE_KEY = 'health_roadmap_file_v2';
const PROFILE = { sex: 'male' as const, heightCm: 180, birthYear: 1974, birthMonth: 1 };


type File = ReturnType<typeof migrateFile>;
/** Another tab writes the record, as its own store would, and this tab hears the storage event. */
async function anotherTabWrites(change: (file: File, now: string) => File) {
  const adapter = new LocalStorageAdapter();
  const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
  const now = new Date(Date.now() + 1000).toISOString();
  await adapter.write(ROADMAP_FILE_NAME, change(migrateFile(body, { deviceId: 'other-device', now }), now), version);
  window.dispatchEvent(new StorageEvent('storage', { key: FILE_KEY }));
}
/** Another writer's erase, as its deleteUserData writes it (HealthTool.erase-event-pins anotherWriterErases). */
function erased(prior: File, now: string): File {
  const file = migrateFile(null, { deviceId: 'other-device', now });
  const epoch = (prior.meta.eraseEpoch ?? 0) + 1;
  file.schemaVersion = CURRENT_SCHEMA_VERSION;
  file.erasedRows = { fromEpoch: epoch, ids: [...new Set(rowRootIds(prior))].sort() };
  file.meta.eraseEpoch = epoch;
  file.meta.erasedAt = now;
  return file;
}

let alerts: string[];
/** Every write the page asked of the store: each write method asks `refuses` first (roadmap-store.ts). */
let asks: ReturnType<typeof vi.spyOn>;
useHealthToolLifecycle();
beforeEach(() => {
  alerts = [];
  vi.stubGlobal('alert', (m: string) => { alerts.push(m); });
  vi.stubGlobal('confirm', () => true);
  trackLiveRefresh();
  asks = vi.spyOn(RoadmapStore.prototype as unknown as { refuses: (erase?: string) => boolean }, 'refuses');
});
afterEach(() => { stopLiveRefresh(); });

async function openPage() {
  await seedGuest(PROFILE, [['weight', 82]]);
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.health-input-panel')).not.toBeNull());
  await settle(1000);
  return view;
}

describe('fix 4 (2b-2, Fable): a re-read never asks a save (US-34 AC4, US-16 AC2a)', () => {
  it('another writer\'s change: its re-read shows it and asks the store for no write', async () => {
    const view = await openPage();
    asks.mockClear();

    await act(async () => { await anotherTabWrites((file, now) => ({ ...file, profile: { ...file.profile, heightCm: 172, updatedAt: now } })); await drain(); });
    await settle(1000);
    openAboutYou(view.container);
    expect(view.container.querySelector<HTMLInputElement>('#heightCm')?.value).toBe('172'); // the re-read showed it
    expect(asks).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  });

  it('another writer\'s erase: its re-read shows it and asks the store for no write', async () => {
    await openPage();
    asks.mockClear();
    const before = getEraseIdentity();
    await act(async () => { await anotherTabWrites(erased); await drain(); });
    await settle(1000);
    expect(getEraseIdentity()).not.toBe(before);
    expect(getShownErase()).toBe(getEraseIdentity()); // the re-read showed the erase
    expect(asks).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  });

  it('a refused save\'s re-read asks for no write: one refusal, one alert, and nothing after', async () => {
    const view = await openPage();
    openAboutYou(view.container);
    asks.mockClear();
    asks.mockReturnValueOnce(true); // the store refuses the next write asked of it

    fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value: '190' } });
    fireEvent.blur(view.container.querySelector('#heightCm')!);
    await settle(700); // the profile save (500 ms), refused, then its re-read
    await settle(1000);

    expect(alerts).toEqual([WRITE_REFUSED]);
    expect(asks).toHaveBeenCalledTimes(1); // the refused save; its re-read asked nothing
    expect(view.container.querySelector<HTMLInputElement>('#heightCm')?.value).toBe('180'); // the record shown again
  });
});
