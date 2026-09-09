import { describe, expect, it, vi } from 'vitest';
import { emptyCheckpoint, encode, fold, readCheckpoint } from './model';
import { MemoryJournal } from './memory-storage';
import { capture, compact, erase, readView, submit } from './protocol';
import { transaction } from './fixtures';

async function put(storage: MemoryJournal, id: string): Promise<void> { await submit(storage, id, encode(transaction(id))); }
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }

describe('US-38 AC1/2/6: checkpoint publication and exact cleanup', () => {
  it('leaves one complete checkpoint and zero temporary objects at quiescence', async () => {
    const storage = new MemoryJournal();
    await put(storage, 'a'); await put(storage, 'b'); await put(storage, 'c');
    expect((await readView(storage)).entries).toHaveLength(3);
    expect(await compact(storage)).toEqual({ captured: 3, removed: 3, status: 'captured-clean' });
    expect(storage.objects.size).toBe(0);
    expect(readCheckpoint(storage.current!.bytes).entries).toHaveLength(3);
    expect((await compact(storage)).removed).toBe(0);
  });

  it.each([false, true])('demonstrates why provider atomicity must be proven, broken primitive=%s', async broken => {
    const storage = new MemoryJournal(); storage.ignorePrecondition = broken;
    await put(storage, 'a');
    const entered = gate(); const resume = gate();
    const publish = storage.publish.bind(storage);
    let first = true;
    storage.publish = async (...args) => {
      if (first) { first = false; entered.release(); await resume.wait; }
      return publish(...args);
    };
    const stale = compact(storage);
    await entered.wait;
    await put(storage, 'b');
    await compact(storage);
    resume.release();
    const result = await stale;
    expect(result.status).toBe(broken ? 'captured-clean' : 'conflict');
    const survived = (await readView(storage)).entries.map(entry => entry.transaction.operationId);
    expect(survived).toEqual(broken ? ['a'] : ['a', 'b']);
  });

  it('refuses an unproven provider, while a dry run makes no mutations', async () => {
    const storage = new MemoryJournal(); storage.atomicPublication = false;
    await put(storage, 'a');
    const before = structuredClone(storage.current);
    await expect(compact(storage)).rejects.toThrow('unproven');
    expect(await compact(storage, true)).toEqual({ status: 'dry-run', captured: 1, removed: 0 });
    expect(storage.current).toEqual(before); expect(storage.objects.size).toBe(1);
  });

  it.each(['before-publication', 'after-publication', 'verification'])('recovers after a crash at %s', async point => {
    const storage = new MemoryJournal(); await put(storage, 'a');
    const publish = storage.publish.bind(storage); const read = storage.readCheckpoint.bind(storage);
    storage.publish = async (...args) => {
      if (point === 'before-publication') throw new Error('crash');
      const result = await publish(...args);
      if (point === 'after-publication') throw new Error('lost acknowledgement');
      storage.readCheckpoint = async () => { throw new Error('crash'); };
      return result;
    };
    await expect(compact(storage)).rejects.toThrow();
    expect(storage.objects.size).toBe(1);
    storage.publish = publish; storage.readCheckpoint = read;
    await compact(storage);
    expect(storage.objects.size).toBe(0);
    expect((await readView(storage)).entries).toHaveLength(1);
  });

  it('resumes partial deletion and never expands the captured deletion set', async () => {
    const storage = new MemoryJournal(); await put(storage, 'a'); await put(storage, 'b');
    const remove = storage.removeObject.bind(storage);
    storage.removeObject = async ref => {
      if (ref.id === 'a') { await put(storage, 'late'); return remove(ref); }
      throw new Error('delete failure');
    };
    expect((await compact(storage)).status).toBe('cleanup-pending');
    expect([...storage.objects.keys()].sort()).toEqual(['b', 'late']);
    expect(readCheckpoint(storage.current!.bytes).entries).toHaveLength(2);
    storage.removeObject = remove;
    await compact(storage);
    expect(storage.objects.size).toBe(0); expect((await readView(storage)).entries).toHaveLength(3);
  });

  it('retains an object whose exact revision changed after capture', async () => {
    const storage = new MemoryJournal(); await put(storage, 'a');
    const publish = storage.publish.bind(storage);
    storage.publish = async (...args) => {
      const result = await publish(...args);
      storage.objects.get('a')!.revision++;
      return result;
    };
    expect((await compact(storage)).status).toBe('cleanup-pending');
    expect(storage.objects.size).toBe(1);
  });

  it('accepts a covering successor published between verification and deletion', async () => {
    const storage = new MemoryJournal(); await put(storage, 'a');
    const remove = storage.removeObject.bind(storage); let first = true;
    storage.removeObject = async ref => {
      if (first) { first = false; await put(storage, 'b'); await compact(storage); }
      return remove(ref);
    };
    expect((await compact(storage)).status).toBe('captured-clean');
    expect(storage.objects.size).toBe(0);
    expect((await readView(storage)).entries.map(entry => entry.transaction.operationId)).toEqual(['a', 'b']);
  });

  it('cannot delete a different transaction recreated under a captured object ID', async () => {
    const storage = new MemoryJournal(); await submit(storage, 'shared', encode(transaction('a')));
    const entered = gate(); const resume = gate();
    const remove = storage.removeObject.bind(storage); let first = true;
    storage.removeObject = async ref => {
      if (first) { first = false; entered.release(); await resume.wait; }
      return remove(ref);
    };
    const older = compact(storage);
    await entered.wait;
    await compact(storage); // Second cleaner deletes the old incarnation.
    await submit(storage, 'shared', encode(transaction('b')));
    resume.release();
    expect((await older).status).toBe('cleanup-pending');
    expect(storage.objects.size).toBe(1);
    expect((await readView(storage)).entries.map(entry => entry.transaction.operationId)).toEqual(['a', 'b']);
    await compact(storage);
    expect(storage.objects.size).toBe(0);
  });

  it('verifies old checkpoint contents too, not merely this pass’s new receipts', async () => {
    const storage = new MemoryJournal(fold(emptyCheckpoint(), [transaction('old')]));
    await put(storage, 'new');
    const publish = storage.publish.bind(storage);
    storage.publish = async (_bytes, revision) => publish(encode(fold(emptyCheckpoint(), [transaction('new')])), revision);
    await expect(compact(storage)).rejects.toThrow('coverage');
    expect(storage.objects.size).toBe(1);
  });
});

describe('US-38 AC3/4/7: retries, coherent discovery and erasure', () => {
  it('reconciles a lost upload acknowledgement with the same bytes and ID', async () => {
    const storage = new MemoryJournal(); const create = storage.createObject.bind(storage);
    storage.createObject = async (...args) => { await create(...args); throw new Error('response lost'); };
    await expect(put(storage, 'a')).rejects.toThrow('response lost');
    await put(storage, 'a');
    expect(storage.objects.size).toBe(1);
    await compact(storage);
    await put(storage, 'a'); // Retry after object GC resolves from complete receipt.
    expect(storage.objects.size).toBe(0);
    await expect(submit(storage, 'a', encode(transaction('a', { edits: [{ key: 'a', value: 'different', expected: null }] })))).rejects.toThrow('identity');
  });

  it('detects a changed payload before compaction and consolidates exact duplicate retry objects', async () => {
    const storage = new MemoryJournal(); await put(storage, 'a');
    await expect(submit(storage, 'a', encode(transaction('b')))).rejects.toThrow('verified');
    await submit(storage, 'duplicate', encode(transaction('a')));
    await compact(storage);
    expect(storage.objects.size).toBe(0); expect((await readView(storage)).entries).toHaveLength(1);
  });

  it('reloads after another compactor makes the transaction listing empty', async () => {
    const storage = new MemoryJournal(); await put(storage, 'a');
    const list = storage.list.bind(storage); let first = true;
    storage.list = async cursor => {
      if (first) { first = false; await compact(storage); }
      return list(cursor);
    };
    expect((await readView(storage)).entries).toHaveLength(1);
    expect(storage.objects.size).toBe(0);
  });

  it('does not skip pre-existing uncovered objects when a cleaner deletes earlier pages', async () => {
    const storage = new MemoryJournal(); await put(storage, 'a'); await put(storage, 'b');
    const entered = gate(); const resume = gate();
    const remove = storage.removeObject.bind(storage); let first = true;
    storage.removeObject = async ref => {
      if (first) { first = false; entered.release(); await resume.wait; }
      return remove(ref);
    };
    const cleaner = compact(storage); await entered.wait;
    await put(storage, 'c'); await put(storage, 'd');
    const list = storage.list.bind(storage);
    storage.list = async cursor => {
      if (cursor !== undefined) { resume.release(); await cleaner; }
      return list(cursor);
    };
    expect((await readView(storage)).entries.map(entry => entry.transaction.operationId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('retries a vanished listed object after reloading the checkpoint', async () => {
    const storage = new MemoryJournal(); await put(storage, 'a');
    const read = storage.readObject.bind(storage); let first = true;
    storage.readObject = async id => {
      if (first) { first = false; await compact(storage); }
      return read(id);
    };
    expect((await readView(storage)).entries).toHaveLength(1);
  });

  it('refuses incomplete/invalid discovery without deleting anything', async () => {
    const storage = new MemoryJournal(); await put(storage, 'a');
    storage.list = async () => ({ objects: [], next: 'same' });
    await expect(compact(storage)).rejects.toThrow('discovery');
    expect(storage.objects.size).toBe(1);
  });

  it('bounds retries when the checkpoint keeps changing', async () => {
    const storage = new MemoryJournal();
    const list = storage.list.bind(storage);
    const spy = vi.fn(async (cursor?: string) => { storage.current!.revision++; return list(cursor); });
    storage.list = spy;
    await expect(capture(storage)).rejects.toThrow('coherent');
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('refuses identity substitutions and oversized discovery without publishing or deleting', async () => {
    const wrong = new MemoryJournal(); await put(wrong, 'a');
    wrong.readObject = async () => ({ id: 'other', revision: 1, bytes: encode(transaction('a')) });
    await expect(compact(wrong)).rejects.toThrow('identity');
    expect(wrong.objects.size).toBe(1); expect(wrong.current!.revision).toBe(1);
    const full = new MemoryJournal();
    for (let i = 0; i < 257; i++) await full.createObject(`x${i}`, encode(transaction(`x${i}`)));
    await expect(compact(full)).rejects.toThrow('capacity');
    expect(full.objects.size).toBe(257); expect(full.current!.revision).toBe(1);
  });

  it('retains unknown/corrupt objects, foreign identities and future generations', async () => {
    for (const bytes of ['bad JSON', encode({ ...transaction('a'), protocol: 2 }), encode(transaction('a', { recordId: 'foreign' })), encode(transaction('a', { generation: 1 }))]) {
      const storage = new MemoryJournal(); await storage.createObject('unknown', bytes);
      await expect(compact(storage)).rejects.toThrow();
      expect(storage.objects.size).toBe(1); expect(storage.current!.revision).toBe(1);
    }
  });

  it('refuses missing checkpoints and generation regression during one read', async () => {
    const storage = new MemoryJournal(); storage.current = null;
    await expect(readView(storage)).rejects.toThrow('missing');
    const erased = new MemoryJournal(emptyCheckpoint('record', 1));
    const read = erased.readCheckpoint.bind(erased); let reads = 0;
    erased.readCheckpoint = async () => ++reads === 1 ? read() : { bytes: encode(emptyCheckpoint()), revision: 2 };
    await expect(readView(erased)).rejects.toThrow('regressed');
  });

  it('remembers the newest observed generation across all coherent-read retries', async () => {
    const storage = new MemoryJournal();
    const replies = [
      { bytes: encode(emptyCheckpoint('record', 0)), revision: 1 },
      { bytes: encode(emptyCheckpoint('record', 1)), revision: 2 },
      { bytes: encode(emptyCheckpoint('record', 0)), revision: 3 },
      { bytes: encode(emptyCheckpoint('record', 0)), revision: 3 },
    ];
    storage.readCheckpoint = async () => replies.shift()!;
    await expect(readView(storage)).rejects.toThrow('regressed');
  });

  it('purges old commands and later old-generation uploads without resurrecting their contents', async () => {
    const storage = new MemoryJournal(); await put(storage, 'a'); await compact(storage);
    await put(storage, 'pending');
    expect(await erase(storage)).toBe(true);
    expect(readCheckpoint(storage.current!.bytes).entries).toEqual([]);
    await compact(storage);
    // A request already in flight arrives after the first purge.
    await storage.createObject('late-old', encode(transaction('late-old')));
    await expect(put(storage, 'a')).rejects.toThrow('generation');
    await compact(storage);
    expect(storage.objects.size).toBe(0); expect((await readView(storage)).registers).toEqual([]);
  });

  it('an upload overlapping authorized erasure is retired, not applied to the new generation', async () => {
    const storage = new MemoryJournal();
    const create = storage.createObject.bind(storage);
    storage.createObject = async (...args) => { await erase(storage); await create(...args); };
    // The intent was read in generation zero before the barrier. The cloud
    // receipt is not a promise that a concurrent erasure cannot retire it.
    await put(storage, 'overlap');
    expect(storage.objects.size).toBe(1);
    expect((await readView(storage)).entries).toEqual([]);
    await compact(storage);
    expect(storage.objects.size).toBe(0);
  });

  it('refuses a stale compactor after an erasure barrier', async () => {
    const storage = new MemoryJournal(); await put(storage, 'a');
    const publish = storage.publish.bind(storage); let first = true;
    storage.publish = async (...args) => {
      if (first) { first = false; await erase(storage); }
      return publish(...args);
    };
    expect((await compact(storage)).status).toBe('conflict');
    expect((await readView(storage)).registers).toEqual([]);
    expect(storage.objects.size).toBe(1);
  });
});
