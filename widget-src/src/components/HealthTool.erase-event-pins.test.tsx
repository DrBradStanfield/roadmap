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
 * - the guarantee (adopt moves the identity and REMOTE_CHANGED fires in the
 *   same task): roadmap-store-erase-signal.test.ts.
 *
 * The whole widget over a REAL RoadmapStore: jsdom's localStorage for another
 * tab's erase (its real storage event and live refresh), a MemoryCloud for
 * this tab's own erase. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, act, within, type RenderResult } from '@testing-library/react';
import { CURRENT_SCHEMA_VERSION, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { rowRootIds } from '@roadmap/health-core/merge';
import { migrateFile } from '@roadmap/health-core/migrate';
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { parseProposedEdit, type ProposedEdit } from '@roadmap/health-core/chat-edits';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import {
  addMeasurement, flushRoadmapStore, getEraseIdentity, getShownErase, initRoadmapStore, saveChangedMeasurements, saveMedication,
} from '../lib/roadmap-data';
import { BT_TIMELINE_DRAFT_KEY, DRAFTS_CLEARED_EVENT } from '../lib/storage';
import { trackProductEvent } from '../lib/server-api';
import { ERASE_FAILED, WRITE_REFUSED } from '../lib/erase-copy';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';
import { deleteButton } from '../testing/settings';

const chat = vi.hoisted(() => ({
  proposeEdit: null as null | ((edits: ProposedEdit[]) => void),
  context: null as null | (() => unknown),
}));
/** The first load's mirror write, held while `gate` is set: the page has not shown its first read. */
const first = vi.hoisted(() => ({ gate: null as null | Promise<void> }));
/** Every erase the page marked as shown (useErase's layout effect), in order. */
const marks = vi.hoisted(() => ({ shown: [] as string[] }));

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({
  ChatEmbed: ({ onProposeEdit, guestInputs }: { onProposeEdit: (edits: ProposedEdit[]) => void; guestInputs: () => unknown }) => {
    chat.proposeEdit = onProposeEdit;
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
  return { ...real, markEraseShown: (identity: string) => { marks.shown.push(identity); real.markEraseShown(identity); } };
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

/** Settle microtasks and short timers without leaving the act scope. */
const drain = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
const settle = async (ms = 0) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); await drain(); }); };

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
  expect(JSON.stringify(chat.context!())).toContain('3.2');
  expect([...view.container.querySelectorAll<HTMLInputElement>('.bt-timeline input')].some(i => i.value === '3.2')).toBe(true);
}
const draftGone = (view: RenderResult) => {
  expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBeNull();
  expect(JSON.stringify(chat.context!())).not.toContain('3.2');
  expect([...view.container.querySelectorAll<HTMLInputElement>('.bt-timeline input')].some(i => i.value === '3.2')).toBe(false);
};

let alerts: string[];
const stops: Array<() => void> = [];
useHealthToolLifecycle();
beforeEach(() => {
  alerts = [];
  marks.shown = [];
  first.gate = null;
  chat.proposeEdit = null;
  chat.context = null;
  vi.stubGlobal('alert', (m: string) => { alerts.push(m); });
  vi.stubGlobal('confirm', () => true);
  // The real live refresh: another tab's storage event re-reads the record.
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
});
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

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
    expect(JSON.stringify([...file.measurements, ...file.labValues])).not.toContain('2.2');
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

describe('US-16 AC2a, US-11 AC6: this tab\'s erase whose write fails (HealthTool handleDeleteData: clearOffFileAfterErase)', () => {
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
});
