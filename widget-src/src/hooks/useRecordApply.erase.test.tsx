// @vitest-environment jsdom
/**
 * Untangle fix 4, PR 2b-3: another writer's erase reaches the erase machine,
 * not the relay (US-16 AC2a, US-34 AC1, AC4). useErase and useRecordApply
 * wired as HealthTool wires them (HealthTool.tsx, the two hook calls), over a
 * fake store whose erase identity the test moves. What each test sees is what
 * the page does: how many times it reads the record, what it shows, what it
 * counts, and what it says.
 *
 * The page-level journeys over a real store are the HealthTool.*erase* tests.
 * Synthetic identities only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { LatestMeasurementsResult } from '../lib/api-types';

const id = (epoch: number) => JSON.stringify([epoch, epoch === 0 ? null : `2026-11-0${epoch}T10:00:00.000Z`]);
const A = id(0); // the record shown at load
const B = id(1); // another writer's erase
const C = id(2); // another writer's next erase

const rec = vi.hoisted(() => ({ identity: '', shown: '', next: null as null | (() => Promise<Record<string, unknown>>) }));
vi.mock('../lib/roadmap-data', () => ({
  getBackendKind: () => 'local',
  getEraseIdentity: () => rec.identity,
  getShownErase: () => rec.shown,
  askedUnder: () => rec.shown,
  markEraseShown: (e: string) => { rec.shown = e; },
  deleteUserData: () => rec.next!(),
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../storage/roadmap-store', () => ({ REMOTE_CHANGED_EVENT: 'hr:remote-changed' }));

import { trackProductEvent } from '../lib/server-api';
import { ERASE_DONE, WRITE_REFUSED } from '../lib/erase-copy';
import { useErase } from './useErase';
import { useRecordApply } from './useRecordApply';

const RESULT = {
  inputs: { heightCm: 170, birthYear: 1981 }, previousMeasurements: [], medications: [], screenings: [], supplements: [],
} as unknown as LatestMeasurementsResult;

let log: string[];
beforeEach(() => {
  vi.clearAllMocks();
  rec.identity = A; rec.shown = A; rec.next = null;
  log = [];
  vi.stubGlobal('alert', (m: string) => { log.push(m === WRITE_REFUSED ? 'alert' : `say ${m}`); });
  vi.stubGlobal('confirm', () => true);
});
afterEach(cleanup); // each page stops listening

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const counted = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'remote_change_applied').length;
const alerts = () => log.filter(l => l === 'alert').length;

function setup(loaded = true) {
  const fx = {
    fail: false,
    /** Runs inside the read, between its first and last await (where the store can move). */
    during: null as null | (() => void),
    setInputs: vi.fn(),
    applyLists: vi.fn(),
    units: { shown: vi.fn(), offered: vi.fn(), pending: vi.fn((): undefined => undefined) },
    later: { markSaved: vi.fn(), flushPendingSave: vi.fn(), flushListSaves: vi.fn(), profileDirty: vi.fn(() => false), clearAnswered: vi.fn() },
    reloadValues: vi.fn(async (): Promise<LatestMeasurementsResult | null> => {
      log.push('read');
      await Promise.resolve();
      fx.during?.();
      if (fx.fail) throw new Error('read failed (test)');
      return RESULT;
    }),
  };
  const hook = renderHook(() => {
    // The two hooks as HealthTool builds them; its reread door drops a failed read's rejection here.
    const erase = useErase({
      clearDrafts: () => {}, forget: () => {},
      reread: reason => { void Promise.resolve(page.signal(reason)).catch(() => {}); },
      shows: () => page.shows(),
      spend: () => fx.later.clearAnswered(true),
    } as Parameters<typeof useErase>[0]);
    const page = useRecordApply({
      setInputs: fx.setInputs, reloadValues: fx.reloadValues, applyLists: fx.applyLists,
      units: fx.units as unknown as Parameters<typeof useRecordApply>[0]['units'],
      erase: erase.store, later: () => fx.later,
    });
    return { erase, page };
  });
  if (loaded) act(() => { hook.result.current.page.firstReadShown(); }); // the page's load, as HealthTool's loadData ends
  const reads = () => fx.reloadValues.mock.calls.length;
  return { fx, hook, reads, now: () => hook.result.current };
}

/** The store took in a change and announces it, as RoadmapStore does: `erase` is the identity it moved to, or null. */
async function announced(erase: string | null, moves = true) {
  if (erase && moves) rec.identity = erase;
  await act(async () => { window.dispatchEvent(new CustomEvent('hr:remote-changed', { detail: { erase } })); });
  await settle();
}

/** This tab's erase, its write held until `finish`; `moves` is the identity the store holds when it resolves. */
function ownErase(page: ReturnType<typeof setup>, result: Record<string, unknown>) {
  let finish!: (moves?: string) => void;
  rec.next = () => new Promise(r => { finish = (moves) => { if (moves) rec.identity = moves; r(result); }; });
  let done!: Promise<boolean>;
  act(() => { done = page.now().erase.eraseAll(); });
  return { finish: async (moves?: string) => { await act(async () => { finish(moves); await done; }); await settle(); } };
}

type Path = [string, (page: ReturnType<typeof setup>) => Promise<void>, { counted: number; reads: number }, boolean?];
const PATHS: Path[] = [
  ['idle: it arrives', async () => { await announced(B); }, { counted: 1, reads: 1 }],
  ['loading-held, then the page shows its first read', async (p) => {
    await announced(B);
    expect(p.reads()).toBe(0); // waits for the first read
    expect(p.now().erase.loaded).toBe(false);
    act(() => { p.now().page.firstReadShown(); });
    await settle();
    expect(p.now().erase.loaded).toBe(true); // the saves open (H37)
  }, { counted: 1, reads: 1 }, false],
  ['loading-held, then the first read fails', async (p) => {
    await announced(B);
    expect(p.reads()).toBe(0);
    act(() => { p.now().page.firstReadFailed(new Error('first read failed (test)')); });
    await settle();
    expect(p.now().erase.loaded).toBe(false); // the saves stay off (L2, H37)
  }, { counted: 1, reads: 1 }, false],
  ['H37 (rule R2): this tab\'s erase ends before the first read shows; a later arrival waits for that read', async (p) => {
    const erase = ownErase(p, { success: true, chatErased: true });
    await erase.finish(B); // this tab's erase
    expect(p.now().erase.loaded).toBe(false); // the saves stay off until the first read shows
    await announced(C); // another writer's, above it
    expect(p.reads()).toBe(0); // held, where before H37 it read at once
    act(() => { p.now().page.firstReadShown(); });
    await settle();
    expect(p.now().erase.loaded).toBe(true);
  }, { counted: 1, reads: 1 }, false],
  ['another writer\'s change held behind a dirty profile, then the erase', async (p) => {
    p.fx.later.profileDirty.mockReturnValue(true);
    await announced(null);
    expect(p.reads()).toBe(0); // held
    await announced(B);
    // The erase's read showed the held change too: the save that cleans the profile reads nothing more.
    p.fx.later.profileDirty.mockReturnValue(false);
    act(() => { p.now().page.saved(); });
    await settle();
  }, { counted: 1, reads: 1 }],
  ['it arrives during this tab\'s erase, and wins (own-end at it)', async (p) => {
    const erase = ownErase(p, { success: true, chatErased: true });
    await announced(B);
    await erase.finish();
    expect(log).toContain(`say ${ERASE_DONE}`);
  }, { counted: 1, reads: 1 }],
  ['it arrives during this tab\'s erase, whose write moves nothing (own-failed)', async (p) => {
    // The store took B in before this erase began, and announces it a pass late (the two-pass fold, H25).
    rec.identity = B;
    const erase = ownErase(p, { success: false, error: 'not saved (test)' });
    await announced(B);
    await erase.finish();
    expect(p.now().erase.shownErase).toBe(B);
  }, { counted: 1, reads: 1 }],
  ['a refused save\'s re-read shows it before its late arrival', async (p) => {
    rec.identity = B; // moved, not yet announced
    act(() => { p.now().erase.writeRefused(A); });
    await settle();
    expect(p.now().erase.shownErase).toBe(B);
    await announced(B);
  }, { counted: 1, reads: 2 }],
  ['an arrival of the identity already shown counts nothing', async (p) => {
    await announced(B);
    vi.mocked(trackProductEvent).mockClear();
    p.fx.reloadValues.mockClear();
    await announced(B);
  }, { counted: 0, reads: 1 }],
];

describe('fix 4 (2b-3): the count of another writer\'s erase', () => {
  it.each(PATHS)('fix 4: one remote erase gives exactly one remote_change_applied on each path: %s', async (_name, run, expected, loaded = true) => {
    const page = setup(loaded);
    await run(page);
    expect({ counted: counted(), reads: page.reads() }).toEqual(expected);
  });

  it('design risk 2: an erase and another change both waiting on the first read give one read, and the erase counts once', async () => {
    const page = setup(false);
    await announced(null);
    await announced(B);
    act(() => { page.now().page.firstReadShown(); });
    await settle();
    expect({ counted: counted(), reads: page.reads() }).toEqual({ counted: 1, reads: 1 });
  });
});

describe('fix 4 (2b-3): a read whose identity moved is dropped (US-16 AC2a)', () => {
  it('two overlapping reads, the first at an identity since moved: only the arrival\'s read shows, and the erase stays shown', async () => {
    const page = setup();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    page.fx.reloadValues.mockImplementationOnce(async () => { log.push('read'); await gate; return RESULT; });
    act(() => { void page.now().page.signal('upload'); }); // read 1 starts at A
    await announced(B); // read 2, the arrival's, starts at B and shows it
    expect(page.now().erase.shownErase).toBe(B);
    expect(page.fx.setInputs).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await settle();
    // Read 1 finished at a moved identity: it shows nothing, neither its record nor its erase.
    expect(page.fx.setInputs).toHaveBeenCalledTimes(1);
    expect(page.now().erase.shownErase).toBe(B);
    expect(page.reads()).toBe(2);
    expect(counted()).toBe(1); // B, once (R4)
  });
});

describe('fix 4 (2b-3 R1, Fable): an arrival carrying the erase the machine shows is a plain remote change', () => {
  /** B shown by a refused save's re-read, before its own late arrival (the two-pass fold, H25). */
  async function bShownEarly() {
    const page = setup();
    rec.identity = B;
    act(() => { page.now().erase.writeRefused(A); });
    await settle();
    expect(page.now().erase.shownErase).toBe(B);
    vi.mocked(trackProductEvent).mockClear();
    page.fx.reloadValues.mockClear();
    return page;
  }

  it('(a) with the profile dirty it is held, as any remote change: nothing read until the save that cleans it, and nothing counted', async () => {
    const page = await bShownEarly();
    page.fx.later.profileDirty.mockReturnValue(true);
    await announced(B);
    expect(page.reads()).toBe(0); // held: the typing stays
    page.fx.later.profileDirty.mockReturnValue(false);
    act(() => { page.now().page.saved(); });
    await settle();
    expect({ counted: counted(), reads: page.reads() }).toEqual({ counted: 0, reads: 1 });
  });

  it('(b) with the profile clean it re-reads, and counts nothing', async () => {
    const page = await bShownEarly();
    await announced(B);
    expect({ counted: counted(), reads: page.reads() }).toEqual({ counted: 0, reads: 1 });
  });

  it('(c) while a different erase is heard, its re-read ends with the heard erase shown and counted once', async () => {
    const page = setup();
    await announced(B); // shown, counted
    page.fx.fail = true;
    await announced(C); // heard; its read fails
    page.fx.fail = false;
    await announced(B, false); // the store stays at C: this re-read reads C
    expect(page.now().erase.shownErase).toBe(C);
    expect(counted()).toBe(2); // B once, C once
  });
});

describe('fix 4 (2b-3), Fable: L1, a heard erase whose read fails, is never left silent', () => {
  // Shown A. B arrives; its read fails. A save asked under A is refused: said, and re-read; that read fails.
  // C arrives; its read fails. A second save asked under A is refused. On 2b-2 alone the machine never heard
  // B or C, A was said, so the refusal read nothing, for good. Now the machine holds C heard, so the refusal re-reads.
  it('two remote erases whose reads fail, then a refused save under the old erase: it re-reads', async () => {
    const page = setup();
    page.fx.fail = true;
    await announced(B);
    act(() => { page.now().erase.writeRefused(A); });
    await settle();
    expect(alerts()).toBe(1);
    await announced(C);
    const before = page.reads();
    expect(before).toBe(3); // B's read, the refusal's, C's: each failed
    page.fx.fail = false;
    act(() => { page.now().erase.writeRefused(A); });
    await settle();
    expect(page.reads()).toBe(before + 1); // the re-read
    expect(page.now().erase.shownErase).toBe(C); // and it showed C
    // Q4: one alert per erase a save was asked under; A was said already.
    expect(alerts()).toBe(1);
  });
});
