/**
 * Log-off teardown (Brad, 2026-06-17): the "Log off this device" action in the
 * backend picker must (a) sign out of the active cloud, (b) wipe the on-device
 * health-data copy so a shared computer leaks nothing, (c) forget the
 * remembered backend, and (d) NEVER delete the user's remote cloud file —
 * reconnecting the same account restores everything.
 *
 * These tests assert the exact localStorage keys cleared + that the active
 * adapter is signed out via its local-only disconnect(), with no remote delete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track the active cloud adapter's disconnect; expose a remoteDelete spy that
// MUST stay uncalled (proves the remote file is never touched on log-off).
const disconnectSpy = vi.fn(async () => {});
const remoteDeleteSpy = vi.fn();

// Stub the cloud adapters (so adapterFor('dropbox') yields a spy-able sign-out)
// while keeping the REAL LocalStorageAdapter — its disconnect() is the on-device
// teardown we want to actually exercise.
vi.mock('../src/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage')>();
  class CloudStub {
    async disconnect() { return disconnectSpy(); }
    delete = remoteDeleteSpy;
    remove = remoteDeleteSpy;
  }
  return {
    ...actual,
    DropboxAdapter: CloudStub,
    GoogleDriveAdapter: CloudStub,
    GitHubAdapter: CloudStub,
    WebDavAdapter: CloudStub,
  };
});

// Real-shaped in-memory localStorage. Stored keys are own ENUMERABLE props so
// Object.keys(localStorage) returns them (the LocalStorageAdapter teardown
// iterates that to clear named files + documents); the Storage methods are
// non-enumerable so they don't show up as data keys.
function makeStorage(): Storage {
  const s = {} as Record<string, string>;
  Object.defineProperties(s, {
    length: { get() { return Object.keys(this).length; } },
    getItem: { value(k: string) { return k in this ? this[k] : null; } },
    setItem: { value(k: string, v: string) { this[k] = String(v); } },
    removeItem: { value(k: string) { delete this[k]; } },
    clear: { value() { for (const k of Object.keys(this)) delete this[k]; } },
    key: { value(i: number) { return Object.keys(this)[i] ?? null; } },
  });
  return s as unknown as Storage;
}

import { logOff, BACKEND_KEY } from './connect';

const FILE_KEY = 'health_roadmap_file_v2';
const REV_KEY = 'health_roadmap_file_v2_rev';
const CHAT_KEY = 'health_roadmap_file_v2:chat-history.json';
const DOC_KEY = 'health_roadmap_doc_v2:scan-123';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const LEGACY_DATA = 'health_roadmap_data';
const AUTH_FLAG = 'health_roadmap_authenticated';
const UNRELATED = 'some_other_app_key';

describe('logOff teardown', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  let store: Storage;

  beforeEach(() => {
    disconnectSpy.mockClear();
    remoteDeleteSpy.mockClear();
    store = makeStorage();
    Object.defineProperty(globalThis, 'localStorage', { value: store, writable: true, configurable: true });

    // Simulate a connected-and-populated device.
    store.setItem(BACKEND_KEY, 'dropbox');
    store.setItem(FILE_KEY, '{"version":2}');
    store.setItem(REV_KEY, '7');
    store.setItem(CHAT_KEY, '{"messages":[]}');
    store.setItem(DOC_KEY, 'data:application/pdf;base64,AAAA');
    store.setItem(DROPBOX_TOKENS, '{"access_token":"secret"}');
    store.setItem(LEGACY_DATA, '{"inputs":{"heightCm":180,"sex":"male"}}');
    store.setItem(AUTH_FLAG, '1');
    store.setItem(UNRELATED, 'keep-me');

    reloadSpy = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      value: { reload: reloadSpy, search: '', href: 'http://localhost/' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the local RoadmapFile cache, named files, and documents', async () => {
    await logOff('dropbox');
    expect(store.getItem(FILE_KEY)).toBeNull();
    expect(store.getItem(REV_KEY)).toBeNull();
    expect(store.getItem(CHAT_KEY)).toBeNull();
    expect(store.getItem(DOC_KEY)).toBeNull();
  });

  it('clears the legacy v1 health blob + authenticated flag (shared-device hygiene)', async () => {
    await logOff('dropbox');
    expect(store.getItem(LEGACY_DATA)).toBeNull();
    expect(store.getItem(AUTH_FLAG)).toBeNull();
  });

  it('forgets the remembered backend selection', async () => {
    await logOff('dropbox');
    expect(store.getItem(BACKEND_KEY)).toBeNull();
  });

  it('signs out of the active cloud (local disconnect) exactly once', async () => {
    await logOff('dropbox');
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('NEVER issues a remote delete against the cloud file', async () => {
    await logOff('dropbox');
    expect(remoteDeleteSpy).not.toHaveBeenCalled();
  });

  it('reloads so the widget returns to the connect screen', async () => {
    await logOff('dropbox');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves unrelated localStorage keys untouched', async () => {
    await logOff('dropbox');
    expect(store.getItem(UNRELATED)).toBe('keep-me');
  });

  it('still wipes the device + reloads even if the cloud disconnect throws', async () => {
    disconnectSpy.mockRejectedValueOnce(new Error('network down'));
    await logOff('dropbox');
    expect(store.getItem(FILE_KEY)).toBeNull();
    expect(store.getItem(BACKEND_KEY)).toBeNull();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(remoteDeleteSpy).not.toHaveBeenCalled();
  });
});
