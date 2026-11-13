// @vitest-environment jsdom
/**
 * Untangle fix 4, step 1: pins of how an erase reaches the page TODAY, written
 * before the erase machine (lib/erase-machine.ts, a reducer in useErase) so
 * that PR can show it changes nothing. Each test cites its story AC.
 *
 * Covered elsewhere, and cited, not repeated:
 * - the store half of another tab's erase (drafts off the device, the page
 *   told once, a later edit kept): roadmap-store-two-tabs.test.ts "takes the
 *   other tab's erase in" (US-34 AC6);
 * - the supplement dose drafts on another device's erase:
 *   HealthTool.supplement-dose.test.tsx "drops the rejected draft after
 *   another device erases" (US-11);
 * - the chat banners on a re-read that brings another device's erase:
 *   HealthTool.chat-profile.test.tsx "clears the proposal and Undo for
 *   another device's erase" (US-16 AC2a), by refreshFromRemote, not the
 *   storage event.
 * - the guarantee (adopt moves the identity and REMOTE_CHANGED is heard
 *   exactly once, in the same task but on the two-pass save-loop fold, which
 *   hears it one pass late by design, state-leads H25):
 *   roadmap-store-erase-signal.test.ts.
 *
 * The whole widget over a REAL RoadmapStore: jsdom's localStorage for another
 * tab's erase (its real storage event and live refresh), a MemoryCloud for
 * this tab's own erase. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatEditTarget } from '../hooks/useChatState';
import { render, fireEvent, waitFor, act, within, type RenderResult } from '@testing-library/react';
import { CURRENT_SCHEMA_VERSION, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { rowRootIds } from '@roadmap/health-core/merge';
import { numberPaths } from '@roadmap/health-core/number-leak.test-helpers';
import { migrateFile } from '@roadmap/health-core/migrate';
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { parseProposedEdit, type ProposedEdit } from '@roadmap/health-core/chat-edits';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import {
  addMeasurement, flushRoadmapStore, getEraseIdentity, getShownErase, initRoadmapStore, saveChangedMeasurements, saveMedication,
} from '../lib/roadmap-data';
import { BT_TIMELINE_DRAFT_KEY, DRAFTS_CLEARED_EVENT, MIRROR_CHANGED_EVENT } from '../lib/storage';
import { ERASE_STALE_TAB } from '@roadmap/health-core/record-session';
import { BACKEND_KEY } from '../storage/web-record-host';
import { trackProductEvent } from '../lib/server-api';
import { ERASE_FAILED, WRITE_REFUSED } from '../lib/erase-copy';
import { openAboutYou, seedGuest, showTables, useHealthToolLifecycle, trackLiveRefresh, stopLiveRefresh } from '../testing/health-tool-harness';
import { deleteButton } from '../testing/settings';

const chat = vi.hoisted(() => ({
  proposeEdit: null as null | ((edits: ProposedEdit[]) => void),
  context: null as null | (() => unknown),
}));
/** The first load's mirror write, held while `gate` is set: the page has not shown its first read. */
const first = vi.hoisted(() => ({ gate: null as null | Promise<void> }));
/** Every erase the page marked as shown (useErase's layout effect), in order. */
const marks = vi.hoisted(() => ({ shown: [] as string[] }));
/** How many times the page read the values (useRecordReads reloadValues: an own-save's read), and each correction's answer. */
const reads = vi.hoisted(() => ({ values: 0, corrections: [] as unknown[] }));

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({
  ChatEmbed: ({ onProposeEdit, guestInputs }: { onProposeEdit: ChatEditTarget; guestInputs: () => unknown }) => {
    chat.proposeEdit = (edits) => onProposeEdit.take(edits, onProposeEdit.ask(), true); // asked and answered at once
    chat.context = guestInputs;
    return null;
  },
}));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('../hooks/useRecordReads', async (importOriginal) => {
  const real = await importOriginal<typeof import('../hooks/useRecordReads')>();
  return {
    ...real,
    mirrorRecord: async (...args: Parameters<typeof real.mirrorRecord>) => { if (first.gate) await first.gate; return real.mirrorRecord(...args); },
  };
});
vi.mock('../lib/roadmap-data', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/roadmap-data')>();
  return {
    ...real,
    markEraseShown: (identity: string) => { marks.shown.push(identity); real.markEraseShown(identity); },
    loadLatestMeasurements: () => { reads.values += 1; return real.loadLatestMeasurements(); },
    correctValue: async (...args: Parameters<typeof real.correctValue>) => { const status = await real.correctValue(...args); reads.corrections.push(status); return status; },
  };
});

import { HealthTool } from './HealthTool';

const FILE_KEY = 'health_roadmap_file_v2';
const PROFILE = { sex: 'male' as const, heightCm: 180, birthYear: 1974, birthMonth: 1 };

/** Another tab (or device) erases the record, as its deleteUserData writes it. `restart`: it then
 *  answers the four questions and saves a weight there, so the whole form, matrices included, still shows here. */
async function anotherWriterErases(adapter: StorageAdapter, restart = false) {
  const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
  const now = new Date(Date.now() + 1000).toISOString();
  const prior = migrateFile(body, { deviceId: 'other-device', now });
  const erased = migrateFile(null, { deviceId: 'other-device', now });
  const epoch = (prior.meta.eraseEpoch ?? 0) + 1;
  erased.schemaVersion = CURRENT_SCHEMA_VERSION;
  erased.erasedRows = { fromEpoch: epoch, ids: [...new Set(rowRootIds(prior))].sort() };
  erased.meta.eraseEpoch = epoch;
  erased.meta.erasedAt = now;
  if (restart) {
    erased.profile = { ...erased.profile, ...PROFILE, updatedAt: now };
    const weight = prior.measurements.find(m => m.metricType === 'weight')!;
    erased.measurements = [{ ...weight, id: 'other-device-weight', value: 60, createdAt: now }];
  }
  await adapter.write(ROADMAP_FILE_NAME, erased, version);
}
/** Another tab of this browser erases; this tab hears the browser's storage event on the record's key. */
async function anotherTabErases(restart = false) {
  await anotherWriterErases(new LocalStorageAdapter(), restart);
  window.dispatchEvent(new StorageEvent('storage', { key: FILE_KEY }));
}


const banners = () => document.body.querySelectorAll('.chat-banners [role="status"]');
const mdRow = (view: RenderResult, name: string) =>
  [...view.container.querySelectorAll<HTMLButtonElement>('.md-row')].find(b => b.querySelector('.md-row-label')?.textContent === name)!;
const valuePage = (view: RenderResult) => view.container.querySelector<HTMLElement>('.mh-page-host .md-page');
const remoteApplied = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'remote_change_applied').length;
const ldlDraft = (): ProposedEdit => ({ kind: 'field', field: 'ldlC', displayValue: 3.2, unitSystem: 'si', date: null } as ProposedEdit);
const statinChange: ProposedEdit = { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' };
/** The chat's two banners: a medication Undo and a height proposal. */
function chatMakesBanners() {
  act(() => chat.proposeEdit!([statinChange, parseProposedEdit('propose_profile_edit', { height: { value: 185, unit: 'cm' } })!]));
}
/** The blood-test matrix holds an unsaved LDL of 3.2 the chat filled in (US-16 AC2): on the device and lent to the plan. */
async function matrixHoldsDraft(view: RenderResult) {
  act(() => chat.proposeEdit!([ldlDraft()]));
  await settle(50);
  expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY) ?? '').toContain('3.2');
  expect(numberPaths(chat.context!(), 3.2)).not.toEqual([]);
  expect([...view.container.querySelectorAll<HTMLInputElement>('.bt-timeline input')].some(i => i.value === '3.2')).toBe(true);
}
const draftGone = (view: RenderResult) => {
  expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBeNull();
  expect(numberPaths(chat.context!(), 3.2)).toEqual([]);
  expect([...view.container.querySelectorAll<HTMLInputElement>('.bt-timeline input')].some(i => i.value === '3.2')).toBe(false);
};

let alerts: string[];
// Fake timers that move with the clock: settle(ms) jumps the saves and writes
// at once, with the same durations, and a waitFor still gets there.
useHealthToolLifecycle({ fakeTimers: true });
/** The harness's drain and settle on the fake clock: twenty macrotask hops,
 *  each running the timers due now, and `ms` jumped at once. */
const drain = async () => { for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0); };
const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); await drain(); }); };
beforeEach(() => {
  alerts = [];
  marks.shown = [];
  first.gate = null;
  chat.proposeEdit = null;
  chat.context = null;
  vi.stubGlobal('alert', (m: string) => { alerts.push(m); });
  vi.stubGlobal('confirm', () => true);
  // The real live refresh: another tab's storage event re-reads the record.
  trackLiveRefresh();
});
afterEach(() => { stopLiveRefresh(); });

async function openPage(): Promise<RenderResult> {
  const view = render(<HealthTool />);
  await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
  await settle(50);
  return view;
}

describe('US-16 AC2a, US-11 AC6: another tab\'s erase, heard through the storage event, at the page', () => {
  it('the page shows the erase, the chat\'s banners go, and the matrix drops the old record\'s draft', async () => {
    await seedGuest(PROFILE, [['weight', 82]], [['statin', 'rosuvastatin', 10]]);
    const view = await openPage();
    chatMakesBanners();
    await matrixHoldsDraft(view);
    await settle(1500); // the medication change saves (300 ms), then the store writes (800 ms): a re-read stands aside while a write waits
    expect(banners()).toHaveLength(2);
    const before = getEraseIdentity();
    expect(getShownErase()).toBe(before);

    await act(async () => { await anotherTabErases(true); await drain(); });
    await settle();

    expect(getEraseIdentity()).not.toBe(before);
    expect(getShownErase()).toBe(getEraseIdentity()); // shownErase moved, and the store's mark with it
    expect(marks.shown.filter(m => m === getEraseIdentity())).toHaveLength(1);
    expect(banners()).toHaveLength(0);
    expect(view.container.querySelector('.bt-timeline')).not.toBeNull(); // the matrix is still mounted: its own state dropped the draft
    draftGone(view);
    expect(remoteApplied()).toBe(1);
    expect(alerts).toEqual([]);
  });
});

describe('US-11 AC6: another tab of this browser erased and already cleared storage up to its erase', () => {
  it('the page drops its screen copy, and its matrix removes the draft it stored', async () => {
    await seedGuest(PROFILE, [['weight', 82]]);
    const view = await openPage();
    await matrixHoldsDraft(view);
    await act(async () => {
      await anotherWriterErases(new LocalStorageAdapter());
      // What the erasing tab's clear left: the erase it cleared storage for (cleared-erase.ts).
      const { body } = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
      const meta = (body as RoadmapFile).meta;
      localStorage.setItem('health_roadmap_cleared_erase', JSON.stringify({ lineage: 'local', erase: JSON.stringify([meta.eraseEpoch, meta.erasedAt]) }));
      window.dispatchEvent(new StorageEvent('storage', { key: FILE_KEY }));
      await drain();
    });
    await settle();
    draftGone(view);
  });
});

describe('US-34 AC4 (loading-held), US-16 AC2a: an erase heard before the page has shown its first read', () => {
  it('waits for that read, then shows, once', async () => {
    await seedGuest(PROFILE, [['weight', 82]]);
    let release!: () => void;
    first.gate = new Promise<void>(r => { release = r; });
    const view = render(<HealthTool />);
    await act(async () => { await drain(); });
    const before = getEraseIdentity();

    await act(async () => { await anotherTabErases(); await drain(); });
    await settle();
    expect(getEraseIdentity()).not.toBe(before); // the store took it in
    expect(getShownErase()).toBe(before); // the page has not shown it: held for the first read
    expect(remoteApplied()).toBe(0);

    await act(async () => { release(); await drain(); });
    await settle();
    expect(getShownErase()).toBe(getEraseIdentity());
    expect(marks.shown.filter(m => m === getEraseIdentity())).toHaveLength(1); // shown once
    expect(remoteApplied()).toBe(1); // applied once
    expect(view.container.querySelector('.md-row')).toBeNull(); // the erased record: no saved value shows
    expect(alerts).toEqual([]);
  });
});

/** A cloud whose erase write waits at a gate; `fail` makes it fail once released. */
class HeldCloud extends MemoryAdapter {
  private gate: Promise<void> | null = null;
  private fail = false;
  private entered: () => void = () => {};
  hold(fail = false) {
    let release!: () => void;
    this.gate = new Promise<void>(r => { release = r; });
    this.fail = fail;
    const reached = new Promise<void>(r => { this.entered = r; });
    return { reached, release };
  }
  open() { this.gate = null; }
  override async write(name: string, body: object, version: string | null, signal?: AbortSignal) {
    if (this.gate && name === ROADMAP_FILE_NAME && ((body as RoadmapFile).meta?.eraseEpoch ?? 0) > 0) {
      this.entered();
      await this.gate;
      if (this.fail) throw new Error('cloud did not answer');
    }
    return super.write(name, body, version, signal);
  }
}
async function cloudGuest(adapter: MemoryAdapter): Promise<RenderResult> {
  localStorage.setItem(BACKEND_KEY, 'memory'); // a cloud page runs with its backend remembered
  await initRoadmapStore(adapter);
  await saveChangedMeasurements(PROFILE, {});
  await addMeasurement('weight', 82, '2026-09-01');
  await saveMedication('statin', 'rosuvastatin', 10, 'mg');
  await flushRoadmapStore();
  return openPage();
}

describe('US-16 AC2a, US-34 AC1: a remote change folded in by this tab\'s own erase write (adversary R1)', () => {
  it('the page hears REMOTE_CHANGED mid-erase; the end state shows this tab\'s erase, and no refusal is said', async () => {
    const cloud = new MemoryCloud();
    const adapter = new HeldCloud(cloud);
    await cloudGuest(adapter);
    const before = getEraseIdentity();
    const heard: string[] = [];
    const onRemote = () => { heard.push(getEraseIdentity()); };
    window.addEventListener(REMOTE_CHANGED_EVENT, onRemote);
    try {
      const erase = adapter.hold();
      fireEvent.click(await waitFor(() => deleteButton()));
      await erase.reached;
      // Another device saves a row while this erase's write is out: the write conflicts, and the save folds it in.
      const other = new MemoryAdapter(cloud);
      const { body, version } = await other.read(ROADMAP_FILE_NAME);
      const file = migrateFile(body, { deviceId: 'other-device', now: new Date().toISOString() });
      const weight = file.measurements.find(m => m.metricType === 'weight')!;
      file.measurements.push({ ...weight, id: 'other-device-weight', value: 77, createdAt: new Date().toISOString() });
      await other.write(ROADMAP_FILE_NAME, file, version);
      erase.release();
      await waitFor(() => expect(alerts).toHaveLength(1), { timeout: 3000 });
    } finally {
      window.removeEventListener(REMOTE_CHANGED_EVENT, onRemote);
    }
    await settle(50);
    expect(heard.length).toBeGreaterThanOrEqual(1); // the fold reached the page during the erase
    expect(heard[0]).not.toBe(before); // heard at this tab's own erase
    expect(getEraseIdentity()).not.toBe(before);
    expect(getShownErase()).toBe(getEraseIdentity()); // the screen shows this tab's erase
    expect(alerts).not.toContain(WRITE_REFUSED);
    expect(alerts).not.toContain(ERASE_FAILED);
  });
});

describe('US-16 AC2a, US-11 AC6: each DRAFTS_CLEARED listener drops its state on another tab\'s erase', () => {
  it('useValuePage: an open value page holding typed text closes, and nothing is saved', async () => {
    await seedGuest(PROFILE, [['weight', 82], ['ldl', 3.9]]);
    const view = await openPage();
    fireEvent.click(await waitFor(() => mdRow(view, 'LDL Cholesterol')));
    fireEvent.change(within(valuePage(view)!).getByLabelText(/Value/), { target: { value: '2.2' } });
    const cleared = vi.fn();
    window.addEventListener(DRAFTS_CLEARED_EVENT, cleared);
    try {
      await act(async () => { await anotherTabErases(true); await drain(); });
      await settle(50);
    } finally {
      window.removeEventListener(DRAFTS_CLEARED_EVENT, cleared);
    }
    expect(cleared).toHaveBeenCalledTimes(1); // the store's adopt, not the page
    expect(valuePage(view)).toBeNull();
    const file = JSON.parse(localStorage.getItem(FILE_KEY)!) as RoadmapFile;
    expect(numberPaths([...file.measurements, ...file.labValues], 2.2)).toEqual([]);
    expect(getShownErase()).toBe(getEraseIdentity());
  });

  it('useMatrixDraft: the blood-test matrix, still mounted, empties its draft on screen and on the device', async () => {
    await seedGuest(PROFILE, [['weight', 82]]);
    const view = await openPage();
    await matrixHoldsDraft(view);
    await act(async () => { await anotherTabErases(true); await drain(); });
    await settle(50);
    expect(view.container.querySelector('.bt-timeline')).not.toBeNull();
    draftGone(view);
  });
});

describe('US-16 AC2a, US-11 AC6: this tab\'s erase whose write fails (useErase eraseAll: the forget door, clearOffFileAfterErase)', () => {
  // What the machine PR must keep. On a failed write the session clears nothing off the file
  // (record-session erase(): clearOffFileData runs only once the flush lands), so the page's own
  // clearOffFileAfterErase is the ONLY DRAFTS_CLEARED. On success it is the second.
  it('failed: one DRAFTS_CLEARED, from the page; the draft and the banners go, the screen shows the erased copy, and the failure is said', async () => {
    const cloud = new MemoryCloud();
    const adapter = new HeldCloud(cloud);
    const view = await cloudGuest(adapter);
    await matrixHoldsDraft(view);
    chatMakesBanners();
    const before = getEraseIdentity();
    const cleared = vi.fn();
    window.addEventListener(DRAFTS_CLEARED_EVENT, cleared);
    try {
      const erase = adapter.hold(true);
      fireEvent.click(await waitFor(() => deleteButton()));
      await erase.reached;
      erase.release();
      await waitFor(() => expect(alerts).toHaveLength(1), { timeout: 3000 });
    } finally {
      window.removeEventListener(DRAFTS_CLEARED_EVENT, cleared);
    }
    adapter.open();
    await settle(50);
    expect(cleared).toHaveBeenCalledTimes(1);
    // record-session's flush error (SAVE_FAILED, not exported), as said today: not ERASE_FAILED, and no word that the erase is kept to retry.
    expect(alerts).toEqual(['Cloud sync failed — your latest changes are still on this device.']);
    expect(getEraseIdentity()).not.toBe(before); // the store holds the erased copy and retries it
    expect(getShownErase()).toBe(getEraseIdentity());
    expect(banners()).toHaveLength(0);
    draftGone(view);
  });

  it('control, the write lands: two DRAFTS_CLEARED, the session\'s then the page\'s', async () => {
    const cloud = new MemoryCloud();
    const view = await cloudGuest(new HeldCloud(cloud));
    await matrixHoldsDraft(view);
    const cleared = vi.fn();
    window.addEventListener(DRAFTS_CLEARED_EVENT, cleared);
    try {
      fireEvent.click(await waitFor(() => deleteButton()));
      await waitFor(() => expect(alerts).toHaveLength(1), { timeout: 3000 });
    } finally {
      window.removeEventListener(DRAFTS_CLEARED_EVENT, cleared);
    }
    expect(cleared).toHaveBeenCalledTimes(2);
    expect(getShownErase()).toBe(getEraseIdentity());
    draftGone(view);
  });

  it('US-11 AC3b, AC6: the write lands but the draft\'s removal is refused: the screen still resets, and the next load clears', async () => {
    const cloud = new MemoryCloud();
    const view = await cloudGuest(new HeldCloud(cloud));
    await matrixHoldsDraft(view);
    chatMakesBanners();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const remove = Storage.prototype.removeItem;
    const refusing = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (key === BT_TIMELINE_DRAFT_KEY) return; // refused, silently
      remove.call(this, key);
    });
    try {
      fireEvent.click(await waitFor(() => deleteButton()));
      await waitFor(() => expect(alerts).toHaveLength(1), { timeout: 3000 });
      await settle(50);
      expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).not.toBeNull(); // still stored: the clear stays owed
      expect(getShownErase()).toBe(getEraseIdentity());
      expect(banners()).toHaveLength(0);
      expect(numberPaths(chat.context!(), 3.2)).toEqual([]);
      expect([...view.container.querySelectorAll<HTMLInputElement>('.bt-timeline input')].some(i => i.value === '3.2')).toBe(false);
    } finally {
      refusing.mockRestore();
    }
    await initRoadmapStore(new MemoryAdapter(cloud)); // the next load
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBeNull();
  });
});

describe('US-11 AC6: an out-of-date tab cannot delete data; it is told to reload', () => {
  it('refused at the decision: the page says so, returns to rest, and never forgets the record (clearLocalStorage, forgetRecord)', async () => {
    const cloud = new MemoryCloud();
    const view = await cloudGuest(new HeldCloud(cloud));
    await matrixHoldsDraft(view);
    localStorage.removeItem(BACKEND_KEY); // another tab chooses "This device"
    const before = getEraseIdentity();
    const device = Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]));
    const forgot = vi.fn(); // clearLocalStorage's event, the forget door's first step
    window.addEventListener(MIRROR_CHANGED_EVENT, forgot);
    try {
      fireEvent.click(await waitFor(() => deleteButton()));
      await waitFor(() => expect(alerts).toHaveLength(1), { timeout: 3000 });
      await settle(50);
    } finally {
      window.removeEventListener(MIRROR_CHANGED_EVENT, forgot);
    }
    expect(alerts).toEqual([ERASE_STALE_TAB]);
    expect(forgot).not.toHaveBeenCalled();
    expect(getEraseIdentity()).toBe(before);
    expect(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))).toEqual(device);
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY) ?? '').toContain('3.2'); // the draft stays
    expect(deleteButton().hasAttribute('disabled')).toBe(false); // back at rest
  });
});

/** A cloud that sends this tab's save round twice: `during` runs as the first record write goes out (an edit
 *  there makes the second pass), and the second write waits at a gate. */
class TwoPassCloud extends MemoryAdapter {
  private script: null | { n: number; during: () => void; entered: () => void; gate: Promise<void> } = null;
  arm(during: () => void) {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(r => { entered = r; });
    this.script = { n: 0, during, entered, gate: new Promise<void>(r => { release = r; }) };
    return { reached, release };
  }
  override async write(name: string, body: object, version: string | null, signal?: AbortSignal) {
    const s = this.script;
    if (s && name === ROADMAP_FILE_NAME) {
      s.n += 1;
      if (s.n === 1) s.during();
      if (s.n === 2) { s.entered(); await s.gate; }
    }
    return super.write(name, body, version, signal);
  }
}

const ldlRow = (view: RenderResult) => [...view.container.querySelectorAll<HTMLElement>('.bt-timeline .bt-row')]
  .find(r => r.querySelector('.bt-name-label')?.textContent === 'LDL Cholesterol');
const heightShown = (view: RenderResult) => view.container.querySelector<HTMLInputElement>('#heightCm')?.value ?? null;

describe('Fix 4 D2 (US-16 AC2a, US-34 AC1): the two-pass fold\'s window, between the erase\'s move and its late REMOTE_CHANGED', () => {
  // By design (state-leads H25): the fold hears the erase one pass late (roadmap-store-erase-signal.test.ts).
  // This pins what the page does in that pass: stale but consistent, and nothing written into the erased record.
  it('the screen keeps the old record whole; a correction asked there is refused and reads nothing; then the erase shows once', async () => {
    const cloud = new MemoryCloud();
    const adapter = new TwoPassCloud(cloud);
    await initRoadmapStore(adapter);
    await saveChangedMeasurements(PROFILE, {});
    await addMeasurement('weight', 82, '2026-09-01');
    await addMeasurement('ldl', 2.1, '2026-08-15');
    await flushRoadmapStore();
    const view = await openPage();
    showTables(view.container);
    const cells = await waitFor(() => { const c = ldlRow(view)!.querySelectorAll('.bt-cell-clickable'); expect(c.length).toBeGreaterThan(0); return c; });
    // About you first: its rows focus their fields in a frame, which would blur the correction editor and arm its click-away.
    openAboutYou(view.container); // the form's height field shows
    const height = heightShown(view);
    expect(height).not.toBeNull();
    expect(height).not.toBe('');
    await settle(50);
    fireEvent.click(cells[cells.length - 1]);
    fireEvent.change(ldlRow(view)!.querySelector('.bt-cell-correcting input')!, { target: { value: '1.9' } });
    const before = getEraseIdentity();
    const heard: string[] = [];
    const onRemote = () => { heard.push(getEraseIdentity()); };
    window.addEventListener(REMOTE_CHANGED_EVENT, onRemote);
    let releaseLoop = () => {};
    try {
      // Another device erases; this tab's next save folds it in, and an edit made while its first write is out
      // sends it round again. The second write waits: the window.
      await anotherWriterErases(new MemoryAdapter(cloud));
      const loop = adapter.arm(() => { void addMeasurement('waist', 90, '2026-09-02'); });
      releaseLoop = loop.release;
      await addMeasurement('weight', 81, '2026-09-05');
      let flushed: Promise<void> = Promise.resolve();
      await act(async () => { flushed = flushRoadmapStore().catch(() => {}); await loop.reached; await drain(); });

      // In the window: the store is at the new erase, the page still at the old, and has heard nothing.
      expect(getEraseIdentity()).not.toBe(before);
      expect(getShownErase()).toBe(before);
      expect(heard).toEqual([]);
      // The old record whole: its saved LDL, its form, and the correction editor still open on it.
      expect(ldlRow(view)).toBeTruthy();
      expect(heightShown(view)).toBe(height);
      expect(ldlRow(view)!.querySelector('.bt-cell-correcting input')).not.toBeNull();

      // A correction asked in the window carries the old erase: refused, and no own-save read follows.
      const valueReads = reads.values;
      reads.corrections.length = 0;
      await act(async () => { fireEvent.keyDown(ldlRow(view)!.querySelector('.bt-cell-correcting input')!, { key: 'Enter' }); await drain(); });
      expect(reads.corrections).toEqual(['error']); // asked, and refused by the store
      expect(reads.values).toBe(valueReads);
      expect(getShownErase()).toBe(before);
      expect(heard).toEqual([]);
      expect(ldlRow(view)).toBeTruthy();
      expect(heightShown(view)).toBe(height);

      await act(async () => { loop.release(); await flushed; await drain(); });
    } finally {
      releaseLoop(); // a failed assertion must not leave the second write hung for afterEach's flush
      window.removeEventListener(REMOTE_CHANGED_EVENT, onRemote);
    }
    await settle(50);
    // Late, never missed: heard once, at the new erase, and the page shows it whole.
    expect(heard).toEqual([getEraseIdentity()]);
    expect(getShownErase()).toBe(getEraseIdentity());
    expect(ldlRow(view)?.querySelectorAll('.bt-cell-clickable').length ?? 0).toBe(0); // no saved LDL shows
    expect(heightShown(view) ?? '').not.toBe(height); // nor the old record's form
    const file = (await new MemoryAdapter(cloud).read(ROADMAP_FILE_NAME)).body as RoadmapFile;
    expect(numberPaths([...file.measurements, ...file.labValues], 1.9)).toEqual([]); // the correction never landed
    expect([...file.measurements, ...file.labValues].some(r => r.correctsId)).toBe(false);
    expect(alerts).not.toContain(ERASE_FAILED);
  });

  // fix 4 D2: "arrived for an identity already shown". A save refused in the window (writeRefused, reason
  // 'refused') shows the new erase before the late REMOTE_CHANGED; that event then re-reads the same record.
  it('US-16 AC2a, US-34 AC4: a profile save refused there says WRITE_REFUSED once and shows the new record whole; the late REMOTE_CHANGED changes nothing', async () => {
    const cloud = new MemoryCloud();
    const adapter = new TwoPassCloud(cloud);
    await initRoadmapStore(adapter);
    await saveChangedMeasurements(PROFILE, {});
    await addMeasurement('weight', 82, '2026-09-01');
    await addMeasurement('ldl', 2.1, '2026-08-15');
    await flushRoadmapStore();
    const view = await openPage();
    showTables(view.container);
    await waitFor(() => expect(ldlRow(view)!.querySelectorAll('.bt-cell-clickable').length).toBeGreaterThan(0));
    openAboutYou(view.container);
    const height = heightShown(view);
    expect(height).not.toBeNull();
    expect(height).not.toBe('');
    const before = getEraseIdentity();
    const heard: string[] = [];
    const onRemote = () => { heard.push(getEraseIdentity()); };
    window.addEventListener(REMOTE_CHANGED_EVENT, onRemote);
    let afterReread = '';
    let releaseLoop = () => {};
    try {
      await anotherWriterErases(new MemoryAdapter(cloud));
      const loop = adapter.arm(() => { void addMeasurement('waist', 90, '2026-09-02'); });
      releaseLoop = loop.release;
      await addMeasurement('weight', 81, '2026-09-05');
      let flushed: Promise<void> = Promise.resolve();
      await act(async () => { flushed = flushRoadmapStore().catch(() => {}); await loop.reached; await drain(); });
      expect(getEraseIdentity()).not.toBe(before);
      expect(getShownErase()).toBe(before); // the window
      expect(heard).toEqual([]);

      // A height typed in the window, the field then left, saves (500 ms) under the old erase: the store refuses it.
      // (Left: until blur the box shows its own typed text, rawInputs, whatever the record.)
      fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value: '190' } });
      fireEvent.blur(view.container.querySelector('#heightCm')!);
      await settle(700);
      expect(alerts).toEqual([WRITE_REFUSED]);
      expect(heard).toEqual([]); // the late event has not come
      // The refusal's re-read ended the window early: the new record shows whole, nothing of the old.
      expect(getShownErase()).toBe(getEraseIdentity());
      expect(ldlRow(view)?.querySelectorAll('.bt-cell-clickable').length ?? 0).toBe(0);
      expect(heightShown(view) ?? '').toBe('');
      // 1 already (fix 4 2b-3, Fable Q1): the erase machine counts another writer's erase where the screen first shows it,
      // and the refusal's re-read showed it. Before the machine, the late arrival counted it instead: the same total, earlier.
      expect(remoteApplied()).toBe(1);
      afterReread = view.container.innerHTML;

      await act(async () => { loop.release(); await flushed; await drain(); });
    } finally {
      releaseLoop(); // a failed assertion must not leave the second write hung for afterEach's flush
      window.removeEventListener(REMOTE_CHANGED_EVENT, onRemote);
    }
    await settle(50);
    expect(heard).toEqual([getEraseIdentity()]); // the late REMOTE_CHANGED, heard once
    expect(alerts).toEqual([WRITE_REFUSED]); // one alert in total
    // 1 in total: the late arrival re-reads the record already shown and counts nothing more (fix 4 D2, an identity
    // already shown; the machine counts each erase once).
    expect(remoteApplied()).toBe(1);
    expect(view.container.innerHTML).toBe(afterReread); // nothing visible changes
    expect(getShownErase()).toBe(getEraseIdentity());
    const file = (await new MemoryAdapter(cloud).read(ROADMAP_FILE_NAME)).body as RoadmapFile;
    expect(file.profile.heightCm ?? null).not.toBe(190); // the refused height never landed
  });

  // fix 4 2b-3 R1 (Fable): the late REMOTE_CHANGED carries the erase the screen already shows, so it is a plain
  // remote change: held behind a dirty profile like any other. (Height, not birth year: on the erased record the
  // year field is not shown yet.)
  it('US-34 AC4, US-16 AC2a: typing after that refusal\'s re-read, the late REMOTE_CHANGED is held: the typed height stays, and its save lands', async () => {
    const cloud = new MemoryCloud();
    const adapter = new TwoPassCloud(cloud);
    await initRoadmapStore(adapter);
    await saveChangedMeasurements(PROFILE, {});
    await addMeasurement('weight', 82, '2026-09-01');
    await flushRoadmapStore();
    const view = await openPage();
    openAboutYou(view.container);
    const before = getEraseIdentity();
    await anotherWriterErases(new MemoryAdapter(cloud));
    const loop = adapter.arm(() => { void addMeasurement('waist', 90, '2026-09-02'); });
    await addMeasurement('weight', 81, '2026-09-05');
    let flushed: Promise<void> = Promise.resolve();
    await act(async () => { flushed = flushRoadmapStore().catch(() => {}); await loop.reached; await drain(); });
    expect(getShownErase()).toBe(before); // the window
    fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value: '190' } });
    fireEvent.blur(view.container.querySelector('#heightCm')!);
    await settle(700);
    expect(alerts).toEqual([WRITE_REFUSED]);
    expect(getShownErase()).toBe(getEraseIdentity()); // the refusal's re-read showed the new erase

    // The person types a height on the new record, still in the field: the profile is dirty.
    const height = view.container.querySelector<HTMLInputElement>('#heightCm')!;
    height.focus();
    fireEvent.change(height, { target: { value: '175' } });
    await act(async () => { loop.release(); await flushed; await drain(); }); // the late REMOTE_CHANGED
    expect(heightShown(view)).toBe('175'); // held: the typing stays

    fireEvent.blur(height);
    await settle(1500); // the profile save (500 ms), then the store writes
    await act(async () => { await flushRoadmapStore().catch(() => {}); await drain(); });
    const file = (await new MemoryAdapter(cloud).read(ROADMAP_FILE_NAME)).body as RoadmapFile;
    expect(file.profile.heightCm).toBe(175); // the form stayed dirty, so its save carried the height up
  });
});
