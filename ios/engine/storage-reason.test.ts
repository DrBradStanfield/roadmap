/**
 * US-09 AC38 (#979): the phone tells a full Dropbox by StorageError's typed
 * reason, never by its words, so a reworded message in dropbox-rest.ts cannot
 * send a full store back to "could not be reached". The save rewraps the error
 * when an earlier write may have landed (sync-manager.ts); the reason rides on
 * the error it wraps.
 */
import { describe, expect, it } from 'vitest';
import { StorageError } from '../../packages/health-core/src/adapter';
import { failed } from './cloud-adapters';

const kindOf = (error: unknown) => (JSON.parse(failed('dropbox', error)) as { kind: string }).kind;

describe('US-09 AC38 (#979): a full Dropbox is read by its reason', () => {
  it('a StorageError with reason storage-full is storage-full, whatever it says', () => {
    expect(kindOf(new StorageError('Dropbox has no room left', undefined, undefined, 409, 'storage-full'))).toBe('storage-full');
  });

  it('the save’s rewrap of a full Dropbox, after an earlier write may have landed, is storage-full', () => {
    const full = new StorageError('Dropbox has no room left', undefined, undefined, 409, 'storage-full');
    expect(kindOf(new StorageError(full.message, 'Read the record again.', full, 409))).toBe('storage-full');
  });

  it('the words alone, with no reason, are not a full Dropbox', () => {
    expect(kindOf(new StorageError('Dropbox is full', undefined, undefined, 409))).toBe('unreachable');
  });
});
