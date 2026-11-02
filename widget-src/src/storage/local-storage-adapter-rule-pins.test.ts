/** @vitest-environment jsdom */
// Rules in local-storage-adapter.ts (the device copy of the record and its
// revision) that no existing test pinned. Each test fails when one small
// change to the rule it names is made in the adapter, a change the existing
// tests that use it still pass with.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core';
import { LocalStorageAdapter, NAMED_FILE_PREFIX } from './local-storage-adapter';

const RECORD_KEY = 'health_roadmap_file_v2';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('LocalStorageAdapter: keys, versions and events', () => {
  it('is always connected', () => {
    expect(new LocalStorageAdapter().isConnected()).toBe(true);
  });

  it('a named file that sorts after the record name never lands on the record key', async () => {
    const adapter = new LocalStorageAdapter();
    await adapter.write('zz-notes.json', { a: 1 }, null);
    expect(localStorage.getItem(RECORD_KEY)).toBeNull();
    expect(localStorage.getItem(NAMED_FILE_PREFIX + 'zz-notes.json')).toBe('{"a":1}');
    expect((await adapter.read(ROADMAP_FILE_NAME)).body).toBeNull();
  });

  it('an empty stored record is corrupt, not absent', () => {
    localStorage.setItem(RECORD_KEY, '');
    expect(() => new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME)).toThrow(StorageError);
  });

  it('read, revision and write agree on an empty version key', () => {
    localStorage.setItem(NAMED_FILE_PREFIX + 'chat-history.json', '{}');
    localStorage.setItem(NAMED_FILE_PREFIX + 'chat-history.json_rev', '');
    const adapter = new LocalStorageAdapter();
    const { version } = adapter.readSync('chat-history.json');
    expect(adapter.revision('chat-history.json')).toBe(version);
    expect(() => adapter.writeSync('chat-history.json', { b: 2 }, version)).not.toThrow();
  });

  it('watch hears only its own key and clear(), not unrelated keys', () => {
    const adapter = new LocalStorageAdapter();
    const onChange = vi.fn();
    const controller = new AbortController();
    adapter.watch(ROADMAP_FILE_NAME, onChange, controller.signal);
    for (const key of ['', '0', 'a', 'health_roadmap_file', 'zzz', RECORD_KEY + '_rev']) {
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }
    expect(onChange).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent('storage', { key: RECORD_KEY }));
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(onChange).toHaveBeenCalledTimes(2);
    controller.abort();
  });

  it('a missing document is a StorageError', async () => {
    await expect(new LocalStorageAdapter().readDocument('no-such-doc')).rejects.toBeInstanceOf(StorageError);
  });
});
