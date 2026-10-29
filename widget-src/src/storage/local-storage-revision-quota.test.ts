/**
 * US-34 AC6a: a local save that reports success has stored both the record
 * and the revision it returns. A refused save leaves both as they were, or,
 * when the old record cannot go back, removes the revision. A
 * storage full by a few bytes used to keep the record, drop the longer
 * revision silently and report the new one, so a stale tab's save still
 * matched and replaced the acknowledged write.
 *
 * The storage below is a uniform byte budget: every key costs the same, none
 * is singled out. No real browser quota is claimed. Math.random is pinned, so
 * the revision's suffix length is chosen, not drawn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core';
import { LocalStorageAdapter } from './local-storage-adapter';

const BODY = 'health_roadmap_file_v2';
const REV = BODY + '_rev';
const before = { value: 0, other: 0 };
const first = { value: 1, other: 0 };
const stale = { value: 0, other: 1 };
const LONG = 0.123456789; // an 8-character suffix
const SHORT = 0.5; // (0.5).toString(36) is "0.i": a 1-character suffix

class ByteBudgetStorage implements Storage {
  private entries = new Map<string, string>();
  limit = Number.POSITIVE_INFINITY;
  rejected: string[] = [];
  /** Refuse a write regardless of room (a write from elsewhere took it). */
  refuse: (key: string, value: string) => boolean = () => false;
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  getItem(k: string) { return this.entries.get(String(k)) ?? null; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  removeItem(k: string) { this.entries.delete(String(k)); }
  get used() { return [...this.entries].reduce((n, [k, v]) => n + 2 * (k.length + v.length), 0); }
  setItem(k: string, v: string) {
    k = String(k); v = String(v);
    const old = this.entries.get(k);
    const after = this.used - (old === undefined ? 0 : 2 * (k.length + old.length)) + 2 * (k.length + v.length);
    if (after > this.limit || this.refuse(k, v)) {
      this.rejected.push(k);
      throw new DOMException('Synthetic uniform byte budget exceeded', 'QuotaExceededError');
    }
    this.entries.set(k, v);
  }
}
/** `slack` bytes past what the stored entries use now. */
function setup(rev: string, slack = Number.POSITIVE_INFINITY, random = LONG) {
  const storage = new ByteBudgetStorage();
  storage.setItem(BODY, JSON.stringify(before));
  storage.setItem(REV, rev);
  storage.limit = storage.used + slack;
  vi.stubGlobal('localStorage', storage);
  vi.spyOn(Math, 'random').mockReturnValue(random);
  return { storage, adapter: new LocalStorageAdapter() };
}
const stored = (storage: Storage) => ({ body: JSON.parse(storage.getItem(BODY)!), rev: storage.getItem(REV) });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a local save at a full storage (US-34 AC6a)', () => {
  it('control: with room, the save stores both and a stale save is refused', () => {
    const { storage, adapter } = setup('0');
    const a = adapter.writeSync(ROADMAP_FILE_NAME, first, '0');
    expect(stored(storage)).toEqual({ body: first, rev: a.version });
    expect(() => adapter.writeSync(ROADMAP_FILE_NAME, stale, '0')).toThrow(ConflictError);
    expect(stored(storage).body).toEqual(first);
  });

  it('control: a same-length revision at a full storage still saves', () => {
    const { storage, adapter } = setup('4-abcdefgh', 0);
    const a = adapter.writeSync(ROADMAP_FILE_NAME, first, '4-abcdefgh');
    expect(a.version).toHaveLength('4-abcdefgh'.length);
    expect(stored(storage)).toEqual({ body: first, rev: a.version });
  });

  it('refuses and puts the record back when a longer revision does not fit', () => {
    // A legacy plain count "0" becomes "1-" and eight characters; the record is the same length.
    const { storage, adapter } = setup('0', 0);
    expect(() => adapter.writeSync(ROADMAP_FILE_NAME, first, '0')).toThrow(StorageError);
    expect(storage.rejected).toEqual([REV]);
    expect(stored(storage)).toEqual({ body: before, rev: '0' });
  });

  it('a short random suffix followed by a full-length one is a longer revision too', () => {
    const { storage, adapter } = setup('4-abcdefgh', 0, SHORT);
    const a = adapter.writeSync(ROADMAP_FILE_NAME, first, '4-abcdefgh');
    expect(a.version).toBe('5-i');
    vi.spyOn(Math, 'random').mockReturnValue(LONG);
    storage.limit = storage.used;
    expect(() => adapter.writeSync(ROADMAP_FILE_NAME, stale, '5-i')).toThrow(StorageError);
    expect(stored(storage)).toEqual({ body: first, rev: '5-i' });
  });

  it('when the record does not fit, refuses and stores nothing', () => {
    const { storage, adapter } = setup('0', 0);
    expect(() => adapter.writeSync(ROADMAP_FILE_NAME, { ...first, more: 'x' }, '0')).toThrow(StorageError);
    expect(storage.rejected).toEqual([BODY]);
    expect(stored(storage)).toEqual({ body: before, rev: '0' });
  });

  it('if the old record cannot go back, the revision goes, so no stale save matches', () => {
    const { storage, adapter } = setup('4-abcdefgh', 0, SHORT);
    adapter.writeSync(ROADMAP_FILE_NAME, before, '4-abcdefgh'); // now "5-i"
    vi.spyOn(Math, 'random').mockReturnValue(LONG);
    storage.limit = storage.used;
    const old = storage.getItem(BODY);
    storage.refuse = (key, value) => key === BODY && value === old;
    let refused: unknown;
    try { adapter.writeSync(ROADMAP_FILE_NAME, first, '5-i'); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(StorageError);
    expect((refused as StorageError).hint).toMatch(/may have been stored/);
    expect(storage.rejected).toEqual([REV, BODY]);
    expect(storage.getItem(REV)).toBeNull();
    storage.refuse = () => false;
    storage.limit = Number.POSITIVE_INFINITY;
    expect(() => adapter.writeSync(ROADMAP_FILE_NAME, stale, '5-i')).toThrow(ConflictError);
  });

  it('if another tab saved in between, its record is kept, not overwritten by the restore', () => {
    const { storage, adapter } = setup('0');
    storage.refuse = (key) => {
      if (key !== REV) return false;
      // Another tab commits its record and revision, then ours is refused.
      storage.refuse = () => false;
      storage.setItem(BODY, JSON.stringify(stale));
      storage.setItem(REV, '7-othertab');
      return true;
    };
    let refused: unknown;
    try { adapter.writeSync(ROADMAP_FILE_NAME, first, '0'); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(StorageError);
    expect((refused as StorageError).hint).toMatch(/may have been stored/);
    expect(stored(storage).body).toEqual(stale);
    // Its revision is gone too, so the other tab re-reads before its next save.
    expect(storage.getItem(REV)).toBeNull();
    expect(() => adapter.writeSync(ROADMAP_FILE_NAME, first, '7-othertab')).toThrow(ConflictError);
  });

  it('from no room to plenty, every save stores what it returns or leaves storage as it was', () => {
    let saved = 0;
    let refused = 0;
    for (const random of [LONG, SHORT]) {
      for (let slack = 0; slack <= 40; slack += 2) {
        const { storage, adapter } = setup('9-abcdefgh', slack, random);
        const was = stored(storage);
        const body = { ...first, n: 'x'.repeat(slack % 7) };
        try {
          const a = adapter.writeSync(ROADMAP_FILE_NAME, body, '9-abcdefgh');
          expect(stored(storage)).toEqual({ body, rev: a.version });
          saved += 1;
        } catch (e) {
          expect(e).toBeInstanceOf(StorageError);
          expect(stored(storage)).toEqual(was);
          refused += 1;
        }
        vi.unstubAllGlobals(); vi.restoreAllMocks();
      }
    }
    // Both outcomes were reached, so the sweep tested each.
    expect(saved).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});
