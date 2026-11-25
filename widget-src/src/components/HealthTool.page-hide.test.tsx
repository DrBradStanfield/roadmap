// @vitest-environment jsdom
/**
 * H92 pins (US-04 AC1, US-06 AC13/AC15, US-03 AC5): what the page puts on the
 * device when it hides or closes, through the browser's own events, in every
 * order they come: a hidden `visibilitychange`, a `pagehide` (iOS Safari can
 * send it alone), both in either order, and either twice. The entrypoint's
 * listener is registered before the page renders, as app.tsx does. Each read is
 * of the bytes on disk at once (readSync): no timer or promise can rescue a save.
 *
 * The whole HealthTool renders over the real RoadmapStore on jsdom's
 * localStorage; only the network edges and the chat's UI are stubbed. Synthetic
 * data only. jsdom models delivery only: this is not a real browser unload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { toOldShape } from '@roadmap/health-core/blood-tests';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import { VITALS_DRAFT_KEY } from '../lib/storage';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { registerPageDeparture } from '../../standalone/page-departure';
import { openAboutYou, recordOnDisk, stopLiveRefresh, trackLiveRefresh } from '../testing/health-tool-harness';
import { showPage, typeInto } from '../testing/matrix-gestures';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
const upload = vi.hoisted(() => ({ onStart: null as null | (() => Promise<void>) }));
vi.mock('./UploadModal', () => ({
  UploadModal: ({ onStart }: { onStart: () => Promise<void> }) => { upload.onStart = onStart; return null; },
}));
// One stage of the page's hide can be made to throw: its waiting list saves.
const listSaves = vi.hoisted(() => ({ fail: false, thrown: 0 }));
vi.mock('../hooks/useListSaves', async importOriginal => {
  const real = await importOriginal<typeof import('../hooks/useListSaves')>();
  return {
    ...real,
    useListSaves: (...args: Parameters<typeof real.useListSaves>) => {
      const saves = real.useListSaves(...args);
      return {
        ...saves,
        flushListSaves: () => {
          if (listSaves.fail && ++listSaves.thrown) throw new Error('Synthetic test: a hide stage failed');
          saves.flushListSaves();
        },
      };
    },
  };
});

import { HealthTool } from './HealthTool';

type Hide = 'hidden' | 'pagehide';
/** Every order the browser sends them in. */
const SEQUENCES: Hide[][] = [
  ['hidden'], ['pagehide'], ['hidden', 'pagehide'], ['pagehide', 'hidden'], ['hidden', 'hidden'], ['pagehide', 'pagehide'],
];
const name = (sequence: Hide[]) => sequence.join(' then ');

const DAY = '2026-08-15';
const afterHook = vi.fn();
let stopDeparture: () => void = () => {};
let writes: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  trackLiveRefresh();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  Element.prototype.scrollIntoView ??= () => {};
  upload.onStart = null;
  listSaves.fail = false;
  listSaves.thrown = 0;
  afterHook.mockReset();
  stopDeparture = registerPageDeparture(afterHook); // before the page renders, as app.tsx registers it
});
afterEach(async () => {
  stopLiveRefresh();
  cleanup();
  stopDeparture();
  showPage();
  listSaves.fail = false;
  await flushRoadmapStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A man with his profile, a weight and one LDL on record. */
async function guest() {
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1980, birthMonth: 1, unitSystem: 'si' }, {});
  await addMeasurement('weight', 82, '2026-09-01');
  await addMeasurement('ldl', 3.0, DAY);
  await flushRoadmapStore();
}
/** The page once both matrices show (the vitals show as one from the second visit). */
async function page(): Promise<RenderResult> {
  await guest();
  const first = render(<HealthTool />);
  await waitFor(() => expect(first.container.querySelector('.bt-timeline-title')).toBeTruthy());
  first.unmount();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.bt-vitals-card')).toBeTruthy());
  writes = vi.spyOn(LocalStorageAdapter.prototype, 'writeSync');
  return view;
}

const onDisk = () => new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as RoadmapFile;
const measured = (metric: string) => toOldShape(onDisk()).measurements.filter(m => m.metricType === metric);
const activeValues = (metric: string) => measured(metric).filter(m => m.status === 'active').map(m => m.value).sort();

function row(scope: Element, label: string): HTMLElement {
  const found = [...scope.querySelectorAll<HTMLElement>('.bt-row')].find(r => r.querySelector('.bt-name-label')?.textContent === label);
  if (!found) throw new Error(`no row ${label}`);
  return found;
}
const bloodMatrix = (view: RenderResult) => view.container.querySelector('.bt-timeline-title')!.closest('.bt-timeline') as HTMLElement;
const vitalsMatrix = (view: RenderResult) => view.container.querySelector('.bt-vitals-card') as HTMLElement;

/** Height typed into About you, not left: the page's own waiting save. */
function typeHeight(view: RenderResult, value: string) {
  openAboutYou(view.container);
  fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value } });
}
/** The saved LDL clicked open and retyped; `leave` blurs it, so its click-away save is asked for. */
function retypeLdl(view: RenderResult, value: string, { leave }: { leave: boolean }): HTMLInputElement {
  const ldl = row(bloodMatrix(view), 'LDL Cholesterol');
  fireEvent.click(ldl.querySelector('.bt-cell-clickable')!);
  const editor = ldl.querySelector('.bt-cell-correcting input') as HTMLInputElement;
  fireEvent.change(editor, { target: { value } });
  if (leave) fireEvent.blur(editor);
  return editor;
}

/** The browser's events, one by one, each read straight after it lands. The
 *  page stays hidden from its first `visibilitychange` on; a `pagehide` before
 *  it comes while the page still shows, as on an iOS Safari navigation. */
function hide<T>(sequence: Hide[], look: () => T): T[] {
  const seen: T[] = [];
  act(() => {
    for (const event of sequence) {
      if (event === 'hidden') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      } else window.dispatchEvent(new Event('pagehide'));
      seen.push(look());
    }
  });
  return seen;
}
const hiddenEvents = (sequence: Hide[]) => sequence.filter(e => e === 'hidden').length;

describe.each(SEQUENCES.map(sequence => ({ label: name(sequence), sequence })))('H92 pins: the page hides ($label)', ({ sequence }) => {
  it(`US-01 AC4: a height typed and not left is on disk after the first event; the next writes nothing`, async () => {
    const view = await page();
    typeHeight(view, '180');
    const seen = hide(sequence, () => ({ height: onDisk().profile.heightCm, writes: writes.mock.calls.length }));
    expect(seen.map(s => s.height)).toEqual(sequence.map(() => 180));
    if (sequence.length === 2) expect(seen[1].writes).toBe(seen[0].writes);
    expect(afterHook).toHaveBeenCalledTimes(hiddenEvents(sequence));
  });

  it(`US-04 AC1: an open editor's click-away save is on disk after the first event, as a correction`, async () => {
    const view = await page();
    retypeLdl(view, '3.4', { leave: true });
    const seen = hide(sequence, () => ({ active: activeValues('ldl'), rows: measured('ldl').length }));
    expect(seen).toEqual(sequence.map(() => ({ active: [3.4], rows: 2 })));
    const [old, fixed] = [measured('ldl').find(m => m.value === 3.0)!, measured('ldl').find(m => m.value === 3.4)!];
    expect(old.status).toBe('entered-in-error');
    expect(fixed).toMatchObject({ status: 'active', correctsId: old.id });
  });

  it(`US-04 AC1: text left in an editor that still has the focus is not saved, and the editor stays open`, async () => {
    const view = await page();
    const editor = retypeLdl(view, '3.4', { leave: false });
    const seen = hide(sequence, () => activeValues('ldl'));
    expect(seen).toEqual(sequence.map(() => [3.0]));
    expect(row(bloodMatrix(view), 'LDL Cholesterol').querySelector('.bt-cell-correcting input')).toBe(editor);
  });

  it(`US-01 AC4 + US-04 AC1: a typed height and an editor's click-away save both reach disk from one hide`, async () => {
    const view = await page();
    retypeLdl(view, '3.4', { leave: true });
    typeHeight(view, '181');
    const seen = hide(sequence, () => ({ height: onDisk().profile.heightCm, ldl: activeValues('ldl') }));
    expect(seen).toEqual(sequence.map(() => ({ height: 181, ldl: [3.4] })));
  });

  it(`US-03 AC5: an open blood-pressure draft stays on the device; the record is not written`, async () => {
    const view = await page();
    const bp = row(vitalsMatrix(view), 'Blood Pressure');
    typeInto(bp.querySelector('.bt-cell-draft input[aria-label="Systolic blood pressure"]') as HTMLInputElement, '120');
    typeInto(bp.querySelector('.bt-cell-draft input[aria-label="Diastolic blood pressure"]') as HTMLInputElement, '80');
    const before = writes.mock.calls.length;
    const seen = hide(sequence, () => [...measured('systolic_bp'), ...measured('diastolic_bp')].length);
    expect(seen).toEqual(sequence.map(() => 0));
    expect(writes.mock.calls.length).toBe(before);
    expect(JSON.parse(localStorage.getItem(VITALS_DRAFT_KEY)!)).toMatchObject({ draft: { values: { sys: '120', dia: '80' } } });
  });

  it(`US-03 AC5: a hide while an upload's start is still saving the drafts loses nothing and writes the value once`, async () => {
    const view = await page();
    typeInto(row(vitalsMatrix(view), 'Waist Circumference').querySelector('.bt-cell-draft input') as HTMLInputElement, '90');
    typeHeight(view, '182');
    let started!: Promise<void>;
    act(() => { started = upload.onStart!(); }); // the drafts' commits begin, not awaited
    const seen = hide(sequence, () => onDisk().profile.heightCm);
    expect(seen).toEqual(sequence.map(() => 182));
    showPage();
    await act(async () => { await started; });
    const record = toOldShape(await recordOnDisk());
    expect(record.measurements.filter(m => m.metricType === 'waist').map(m => [m.value, m.status])).toEqual([[90, 'active']]);
    expect(record.profile.heightCm).toBe(182);
  });

  it(`US-10 AC5a: with nothing waiting, the hide writes nothing`, async () => {
    await page();
    const before = new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME);
    const seen = hide(sequence, () => writes.mock.calls.length);
    expect(seen).toEqual(sequence.map(() => 0));
    expect(new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME)).toEqual(before);
    expect(afterHook).toHaveBeenCalledTimes(hiddenEvents(sequence));
  });

  it(`US-04 AC1: a hide stage that throws does not lose the typed height or the editor's save`, async () => {
    const view = await page();
    const swallow = (e: ErrorEvent) => e.preventDefault(); // jsdom reports a listener's throw here
    window.addEventListener('error', swallow);
    try {
      retypeLdl(view, '3.4', { leave: true });
      typeHeight(view, '183');
      listSaves.fail = true;
      const seen = hide(sequence, () => ({ height: onDisk().profile.heightCm, ldl: activeValues('ldl') }));
      expect(listSaves.thrown).toBeGreaterThan(0);
      expect(seen).toEqual(sequence.map(() => ({ height: 183, ldl: [3.4] })));
    } finally {
      window.removeEventListener('error', swallow);
    }
  });
});
