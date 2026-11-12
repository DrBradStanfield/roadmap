// @vitest-environment jsdom
/**
 * US-16 AC2d: the shown erase moves when the new record is on screen. A page
 * re-read that brings another device's erase shows it in a later task than
 * the one that read it: React commits the new tree after. Until then the old
 * tree is still on screen, and a save asked from it belongs to the old record.
 * Before, the store's mark moved as the re-read finished, so such a save took
 * the new erase and was accepted into the new record.
 *
 * The gap, faithfully: React 18 holds every render queued inside an act()
 * scope until the outermost scope exits. So inside one act, another device
 * erases, this page's store re-reads, the page's apply runs to its end
 * (its `read` dispatched to the erase machine), and a writer on the old tree fires; React commits
 * only as the act exits. Each row checks the old tree was still on screen.
 *
 * Each writer the page reaches from a form control has a row; a new one needs
 * one. Not rowed: the chat's edits, which an unshown erase drops (AC2a).
 * Whole widget over a REAL RoadmapStore on jsdom's localStorage. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'react-dom';
import { render, fireEvent, waitFor, act, screen, within, type RenderResult } from '@testing-library/react';
import { CURRENT_SCHEMA_VERSION, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { rowRootIds } from '@roadmap/health-core/merge';
import { migrateFile } from '@roadmap/health-core/migrate';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addLabValue, addMeasurement, flushRoadmapStore, getEraseIdentity, getShownErase, saveSupplement, sendGuestReport } from '../lib/roadmap-data';
import { localDay } from '@roadmap/health-core/merge';
import { RECORD_CHANGED } from './AddLabTest';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { WRITE_REFUSED } from '../lib/erase-copy';
import { openAboutYou, seedGuest, showTables, useHealthToolLifecycle } from '../testing/health-tool-harness';
import { deleteButton } from '../testing/settings';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/roadmap-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/roadmap-data')>()),
  sendGuestReport: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));

import { HealthTool } from './HealthTool';

/** A synthetic report: one LDL, a value the record does not hold. */
const extraction = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } };

/** The record as the device holds it once the store's writes are out. */
async function onDisk(): Promise<RoadmapFile> {
  await act(async () => { await flushRoadmapStore(); });
  return (await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body as RoadmapFile;
}

/** Another device erases the record, as its deleteUserData writes it, and this page's storage is told.
 *  `restart`: it then answers the four questions there ('answers'), and a weight too ('weight'), so the whole form still shows here. */
async function anotherDeviceErases(restart: false | 'answers' | 'weight' = false) {
  const adapter = new LocalStorageAdapter();
  const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
  const now = new Date(Date.now() + 1000).toISOString();
  const prior = migrateFile(body, { deviceId: 'other-device', now });
  const erased = migrateFile(null, { deviceId: 'other-device', now });
  const epoch = (prior.meta.eraseEpoch ?? 0) + 1;
  erased.schemaVersion = CURRENT_SCHEMA_VERSION;
  erased.erasedRows = { fromEpoch: epoch, ids: [...new Set(rowRootIds(prior))].sort() };
  erased.meta.eraseEpoch = epoch;
  erased.meta.erasedAt = now;
  if (restart) erased.profile = { ...erased.profile, ...PROFILE, updatedAt: now };
  if (restart === 'weight') {
    const weight = prior.measurements.find(m => m.metricType === 'weight')!;
    erased.measurements = [{ ...weight, id: 'other-device-weight', value: 60, createdAt: now }];
  }
  await adapter.write(ROADMAP_FILE_NAME, erased, version);
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
}

/** Settle microtasks and short timers without leaving the act scope (so React renders nothing). */
const drain = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };

/**
 * Another device's erase reaches this page, which re-reads and shows it, and
 * `fire` runs on the old tree before React commits the new one. `onOld` is a
 * check that holds only while the old tree is on screen.
 */
async function inTheGap(fire: () => void | Promise<void>, onOld: () => boolean) {
  const before = getEraseIdentity();
  await act(async () => {
    await anotherDeviceErases();
    await drain();
    expect(getEraseIdentity()).not.toBe(before); // the store adopted the erase
    expect(onOld()).toBe(true); // React has not committed the new tree
    await fire();
    await drain();
  });
}

const PROFILE = { sex: 'female' as const, heightCm: 178, birthYear: 1960, birthMonth: 1 };
const leave = () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
};

let alerts: string[];
const stops: Array<() => void> = [];
useHealthToolLifecycle();
beforeEach(() => {
  alerts = [];
  vi.stubGlobal('alert', (m: string) => { alerts.push(m); });
  vi.stubGlobal('confirm', () => true);
  // The real live refresh: a storage event from another writer re-reads the record.
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(extraction as Awaited<ReturnType<typeof labImport>>);
  vi.mocked(sendGuestReport).mockResolvedValue({ success: true });
  vi.spyOn(window, 'open').mockReturnValue(null);
  vi.stubGlobal('HealthUpload', {
    extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false })),
    isPdf: () => true, isZip: () => false, isImage: () => false,
  });
});
afterEach(() => {
  Reflect.deleteProperty(document, 'visibilityState');
  for (const stop of stops.splice(0)) stop();
});

interface Writer {
  /** The record before the page opens. */
  seed: () => Promise<void>;
  /** The old tree's writer, open and ready. */
  open: (view: RenderResult) => Promise<void>;
  /** True while the old tree is on screen. */
  onOld: (view: RenderResult) => boolean;
  /** The writer, asked from the old tree. */
  fire: (view: RenderResult) => void | Promise<void>;
  /** What the writer would have put in the new record. */
  written: (file: RoadmapFile) => unknown[];
}

const seedProfile = () => seedGuest(PROFILE, [['weight', 101.4]], [['glp1', 'semaglutide_injection', 1]]);
const lpaUnits = (view: RenderResult) => view.container.querySelector('[role=radiogroup][aria-label="Lp(a) unit"]');
const heightField = (view: RenderResult) => view.container.querySelector<HTMLInputElement>('#heightCm');

/** "+ Add a blood test", open with a ferritin typed, ready to save. */
async function typeFerritin(view: RenderResult) {
  fireEvent.click(await waitFor(() => view.getAllByRole('button', { name: '+ Add a blood test' })[0]));
  fireEvent.change(view.getByLabelText('Test'), { target: { value: 'ferritin' } });
  fireEvent.change(view.getByLabelText('Value'), { target: { value: '80' } });
}
/** The record's value rows that name `metric` (a core blood test is a flagged lab row, US-66). */
const rowsNaming = (metric: string) => (file: RoadmapFile) => [...file.measurements, ...file.labValues].filter(v => JSON.stringify(v).includes(`"${metric}"`));
/** The profile, a weight, and LDL on two days (the latest 2.1 on 2026-08-15). */
async function seedWithLdl() {
  await seedProfile();
  await addMeasurement('ldl', 3.9, '2026-01-10');
  await addMeasurement('ldl', 2.1, '2026-08-15');
  await flushRoadmapStore();
}
const mdRow = (view: RenderResult, name: string) =>
  [...view.container.querySelectorAll<HTMLButtonElement>('.md-row')].find(b => b.querySelector('.md-row-label')?.textContent === name)!;
const valuePage = (view: RenderResult) => view.container.querySelector<HTMLElement>('.mh-page-host .md-page');
const ldlRow = (view: RenderResult) => [...view.container.querySelectorAll<HTMLElement>('.bt-timeline .bt-row')]
  .find(r => r.querySelector('.bt-name-label')?.textContent === 'LDL Cholesterol');

const writers: Record<string, Writer> = {
  'the upload review\'s Save': {
    seed: seedProfile,
    open: async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Upload lab results' }));
      fireEvent.click(screen.getByRole('button', { name: /Continue without keeping my files/ }));
      fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' })] } });
      await screen.findByDisplayValue('3.9');
    },
    onOld: () => screen.queryByDisplayValue('3.9') !== null,
    fire: () => { fireEvent.click(screen.getByRole('button', { name: /^Save 1 Value/ })); },
    written: rowsNaming('ldl'),
  },
  // Passes on main too: a keystroke in a controlled field makes React flush its pending work to
  // restore the field, so the queued re-read commits with it and the old tree never commits alone.
  // It pins that the old screen's profile, which the re-read has already marked unsaved against the
  // new record's empty one, is not written. The keystroke rides into the new form, shows, and saves.
  'a profile edit, flushed as the page hides': {
    seed: seedProfile,
    open: async view => { openAboutYou(view.container); await waitFor(() => expect(heightField(view)).not.toBeNull()); },
    onOld: view => heightField(view)?.value === '178',
    fire: view => {
      flushSync(() => { fireEvent.change(heightField(view)!, { target: { value: '181' } }); });
      leave();
    },
    written: file => [file.profile.sex, file.profile.birthYear, file.profile.birthMonth].filter(v => v !== undefined),
  },
  'a vitals field, left, then flushed as the page hides': {
    // A record past the four answers: the whole form, the waist a first-time field (US-01 AC3).
    seed: () => seedGuest(PROFILE, [['ldl', 3]]),
    // Typed before the erase; left (the save's erase is taken here) after it is read.
    open: async view => {
      await waitFor(() => expect(view.container.querySelector('#waistCm')).not.toBeNull());
      fireEvent.change(view.container.querySelector('#waistCm')!, { target: { value: '90' } });
    },
    onOld: view => view.container.querySelector<HTMLInputElement>('#waistCm')?.value === '90',
    fire: view => { fireEvent.blur(view.container.querySelector('#waistCm')!); leave(); },
    written: rowsNaming('waist'),
  },
  'a medication dose, flushed as the page hides': {
    seed: seedProfile,
    open: async view => { await waitFor(() => expect(view.container.querySelector('#glp1-dose')).not.toBeNull()); },
    onOld: view => view.container.querySelector('#glp1-dose') !== null,
    fire: view => { fireEvent.change(view.container.querySelector('#glp1-dose')!, { target: { value: '1.7' } }); leave(); },
    written: file => file.medications.filter(m => m.doseValue === 1.7),
  },
  'a supplement dose, flushed as the page hides': {
    seed: async () => { await seedProfile(); await saveSupplement('custom_test_supplement', 'Test supplement', 25, 'mg'); await flushRoadmapStore(); },
    open: async view => { await waitFor(() => expect(view.container.querySelector('.supplement-dose')).not.toBeNull()); },
    onOld: view => view.container.querySelector('.supplement-dose') !== null,
    fire: view => { fireEvent.change(view.container.querySelector('.supplement-dose')!, { target: { value: '50' } }); leave(); },
    written: file => file.supplements.filter(x => x.doseValue === 50),
  },
  'a screening answer, flushed as the page hides': {
    // 178 cm, 101.4 kg, born 1960: the DEXA question shows.
    seed: seedProfile,
    open: async view => { await waitFor(() => expect(view.container.querySelector('#dexa-screening')).not.toBeNull()); },
    onOld: view => view.container.querySelector('#dexa-screening') !== null,
    fire: view => { fireEvent.change(view.container.querySelector('#dexa-screening')!, { target: { value: 'dexa_scan' } }); leave(); },
    written: file => (JSON.stringify(file.screenings ?? {}).includes('dexa_scan') ? [file.screenings] : []),
  },
  'the Lp(a) unit': {
    seed: seedProfile,
    open: async view => { showTables(view.container); await waitFor(() => expect(lpaUnits(view)).not.toBeNull()); },
    onOld: view => lpaUnits(view) !== null,
    fire: view => { fireEvent.click([...lpaUnits(view)!.querySelectorAll<HTMLElement>('[role=radio]')].find(b => b.getAttribute('aria-checked') === 'false')!); },
    written: file => (file.profile.lpaUnit ? [file.profile.lpaUnit] : []),
  },
  'the email capture\'s captured flag': {
    seed: seedProfile,
    open: async view => {
      await waitFor(() => expect(view.container.querySelector('#guestEmail')).not.toBeNull());
      fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'reader@example.com' } });
    },
    onOld: view => view.container.querySelector('#guestEmail') !== null,
    fire: view => { fireEvent.click(view.container.querySelector('.email-capture .btn-primary')!); },
    written: file => (file.profile.reportEmailCaptured ? [true] : []),
  },
  'Add a blood test\'s Save': {
    seed: seedProfile,
    open: async view => { await typeFerritin(view); },
    onOld: view => view.container.querySelector('.alr-add-save') !== null,
    fire: view => { fireEvent.click(view.container.querySelector('.alr-add-save')!); },
    written: rowsNaming('ferritin'),
  },
  // Fix 4 step 1 (untangle): the three writers this table lacked. The value page's Add carries the erase it
  // froze, or the store's mark (ValuePage AddValue ~292); the matrix's correction and the move carry none and
  // ride on the store's mark (BloodTestTimeline ~933 onCorrect(opened, newValue); HealthTool moveTest.move).
  'the value page\'s Add': {
    seed: seedWithLdl,
    open: async view => {
      fireEvent.click(await waitFor(() => mdRow(view, 'LDL Cholesterol')));
      fireEvent.change(within(valuePage(view)!).getByLabelText(/Value/), { target: { value: '2.2' } });
    },
    onOld: view => valuePage(view) !== null,
    fire: view => { fireEvent.click(valuePage(view)!.querySelector('.md-add-save')!); },
    written: file => [...file.measurements, ...file.labValues].filter(v => JSON.stringify(v).includes('"ldl"') && JSON.stringify(v).includes('2.2')),
  },
  'a correction from the matrix\'s saved-value editor': {
    seed: seedWithLdl,
    open: async view => {
      showTables(view.container);
      const cells = await waitFor(() => { const c = ldlRow(view)!.querySelectorAll('.bt-cell-clickable'); expect(c.length).toBeGreaterThan(0); return c; });
      fireEvent.click(cells[cells.length - 1]);
      fireEvent.change(ldlRow(view)!.querySelector('.bt-cell-correcting input')!, { target: { value: '1.9' } });
    },
    onOld: view => ldlRow(view)?.querySelector('.bt-cell-correcting input') != null,
    fire: view => { fireEvent.keyDown(ldlRow(view)!.querySelector('.bt-cell-correcting input')!, { key: 'Enter' }); },
    written: file => [...file.measurements, ...file.labValues].filter(v => JSON.stringify(v).includes('"ldl"') && JSON.stringify(v).includes('1.9')),
  },
  'a blood test moved to its day': {
    seed: seedWithLdl,
    open: async view => {
      showTables(view.container);
      const header = await waitFor(() => [...view.container.querySelectorAll<HTMLElement>('.bt-timeline .bt-cell-movable')]
        .find(b => b.querySelector('input')!.value === '2026-08-15')!);
      fireEvent.change(header.querySelector('input[type="date"]')!, { target: { value: '2025-12-01' } });
      await waitFor(() => expect(view.container.querySelector('.bt-move-panel')).not.toBeNull());
    },
    onOld: view => view.container.querySelector('.bt-move-panel') !== null,
    fire: view => { fireEvent.click(within(view.container.querySelector<HTMLElement>('.bt-move-panel')!).getByRole('button', { name: 'Move' })); },
    written: file => [...file.measurements, ...file.labValues].filter(v => JSON.stringify(v).includes('2025-12-01')),
  },
};

describe('US-16 AC2d: a save asked from the old tree, after the erase is read but before the new tree is on screen, is refused', () => {
  it.each(Object.keys(writers))('%s', async name => {
    const w = writers[name];
    await w.seed();
    const view = render(<HealthTool />);
    await act(async () => { await drain(); });
    await w.open(view);
    await inTheGap(() => w.fire(view), () => w.onOld(view));
    await act(async () => { await drain(); });
    expect(getShownErase()).toBe(getEraseIdentity()); // the new record is shown now
    expect(w.written(await onDisk())).toEqual([]);
    // Refused like a save armed before the erase was shown: said once per erase, with a re-read (AC2a, adversary R5).
    expect(alerts.filter(a => a === WRITE_REFUSED).length).toBeLessThanOrEqual(1);
  });

  // Each row's control: with no erase, the same writer saves, so the row above is not passing on a writer that writes nothing.
  it.each(Object.keys(writers))('control, no erase: %s saves', async name => {
    const w = writers[name];
    await w.seed();
    const view = render(<HealthTool />);
    await act(async () => { await drain(); });
    await w.open(view);
    await act(async () => { await w.fire(view); await drain(); });
    expect(w.written(await onDisk())).not.toEqual([]);
  });
});

/** Another device's erase, read and shown, the new tree committed. */
async function anotherDeviceErasesAndPageShowsIt(restart: false | 'answers' | 'weight' = false) {
  const before = getEraseIdentity();
  await act(async () => { await anotherDeviceErases(restart); await drain(); });
  await act(async () => { await drain(); });
  expect(getEraseIdentity()).not.toBe(before);
  expect(getShownErase()).toBe(getEraseIdentity());
}

describe('US-16 AC2d: a write asked before an erase is shown does not land in the new record', () => {
  it('the email capture: an erase shown while the sign-up is out leaves the new record uncaptured', async () => {
    let answer!: (r: { success: boolean }) => void;
    vi.mocked(sendGuestReport).mockImplementation(() => new Promise(r => { answer = r; }));
    await seedProfile();
    const view = render(<HealthTool />);
    await act(async () => { await drain(); });
    await writers['the email capture\'s captured flag'].open(view);
    await act(async () => { fireEvent.click(view.container.querySelector('.email-capture .btn-primary')!); await drain(); });
    expect(sendGuestReport).toHaveBeenCalledOnce();
    await anotherDeviceErasesAndPageShowsIt();
    await act(async () => { answer({ success: true }); await drain(); });
    expect((await onDisk()).profile.reportEmailCaptured).toBeUndefined();
  });

  it('Add a blood test: a value typed before the erase is not saved into the new record', async () => {
    await seedProfile();
    const view = render(<HealthTool />);
    await act(async () => { await drain(); });
    await typeFerritin(view);
    await anotherDeviceErasesAndPageShowsIt('weight');
    // The form survives the erase: the new record has the four answers, so the whole form still shows.
    const save = view.container.querySelector<HTMLButtonElement>('.alr-add-save');
    expect(save).not.toBeNull();
    await act(async () => { fireEvent.click(save!); await drain(); });
    expect(rowsNaming('ferritin')(await onDisk())).toEqual([]);
    // The form closes, its old value gone, and says why; it does not ask for a retry that cannot succeed.
    expect(view.container.querySelector('.alr-add-save')).toBeNull();
    expect(view.queryByText('Could not save — please try again.')).toBeNull();
    expect(view.getByText(RECORD_CHANGED)).toBeTruthy();
    // Opened again, it saves into the record now shown.
    await typeFerritin(view);
    await act(async () => { fireEvent.click(view.container.querySelector('.alr-add-save')!); await drain(); });
    expect(rowsNaming('ferritin')(await onDisk())).toHaveLength(1);
    expect(view.queryByText(RECORD_CHANGED)).toBeNull();
  });

  it('Add a blood test: a Replace offered before the erase closes the form after it, and writes nothing', async () => {
    await seedProfile();
    await addLabValue({ metricName: 'ferritin', unit: 'µg/L', value: 50, day: localDay(new Date()) });
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await act(async () => { await drain(); });
    await typeFerritin(view); // 80 on a day that holds 50
    await act(async () => { fireEvent.click(view.container.querySelector('.alr-add-save')!); await drain(); });
    expect(view.container.querySelector('.alr-add-save')?.textContent).toMatch(/^Replace/);
    await anotherDeviceErasesAndPageShowsIt('weight');
    await act(async () => { fireEvent.click(view.container.querySelector('.alr-add-save')!); await drain(); });
    expect(view.container.querySelector('.alr-add-save')).toBeNull();
    expect(view.getByText(RECORD_CHANGED)).toBeTruthy();
    expect(rowsNaming('ferritin')(await onDisk())).toEqual([]);
  });

  // US-62 AC25b: a refused save re-reads and spends a waiting landing. One armed on the old
  // screen spends nothing of the new record's: it is still said, once (AC2a).
  it('a list save armed on the old screen and refused after the new record shows leaves the new record\'s landing', async () => {
    await seedProfile();
    const view = render(<HealthTool />);
    await act(async () => { await drain(); });
    await waitFor(() => expect(view.container.querySelector('#glp1-dose')).not.toBeNull());
    fireEvent.change(view.container.querySelector('#glp1-dose')!, { target: { value: '1.7' } }); // saves in 300 ms, under the old erase
    await anotherDeviceErasesAndPageShowsIt('answers'); // the new record lacks only the weight
    const weight = await waitFor(() => view.container.querySelector<HTMLInputElement>('#weightKg')!);
    act(() => { weight.focus(); });
    fireEvent.change(weight, { target: { value: '25' } }); // the last answer; may become 250: an 800 ms wait
    await act(async () => { await new Promise(r => setTimeout(r, 1200)); });
    expect(alerts.filter(a => a === WRITE_REFUSED)).toHaveLength(1);
    expect(document.activeElement?.matches('.mh-ready-title, .mh-title')).toBe(true); // landed
  });
});

describe('US-16 AC2a: after this tab\'s own erase, the new record takes saves', () => {
  it('a height typed after "Delete all my data" is saved into the new record', async () => {
    await seedProfile();
    const view = render(<HealthTool />);
    await act(async () => { await drain(); });
    const before = getEraseIdentity();
    fireEvent.click(await waitFor(() => deleteButton()));
    await waitFor(() => expect(alerts).toHaveLength(1), { timeout: 3000 }); // the erase says it is done
    expect(getEraseIdentity()).not.toBe(before);
    expect(getShownErase()).toBe(getEraseIdentity());
    await act(async () => { fireEvent.change(heightField(view)!, { target: { value: '170' } }); await drain(); });
    act(() => leave());
    expect((await onDisk()).profile.heightCm).toBe(170);
    expect(alerts).not.toContain(WRITE_REFUSED);
  });
});
