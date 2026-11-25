// @vitest-environment jsdom
/**
 * US-09 AC7l, across the whole widget: text from the person's record is shown as text, never
 * copied into an attribute. A record whose every free-text field holds its own made-up word, and
 * whose every core metric holds an unusual number, is rendered through the real HealthTool and
 * store, and each main screen is walked: My data (rows, each value's page with its chart, the
 * grids), My health with its documents and a document opened, Settings, the chat column's thread
 * list and a thread opened, the history lightbox, each phone tab, the reminders line and the upload
 * review. The medication's free text and the document's metadata are in the record though no
 * screen shows them. Synthetic record; the chat's and the upload's network is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { customSupplementAdd } from '@roadmap/health-core/input-form';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import {
  addMeasurement, flushRoadmapStore, initRoadmapStore, openHistoryLightbox, saveChangedMeasurements, saveMedication, saveSupplement,
  setReminderOptIn, getShownErase,
} from '../lib/roadmap-data';
import { formatShortDate } from '../lib/constants';
import { formatDisplayValue, type MetricType } from '@roadmap/health-core/units';
import { recordTextInAttributes } from '../testing/no-record-text-in-attributes';
import { seedOpenDocuments, seedOpenLabValues } from '../testing/seed-record';
import { UPLOAD_ENGINE } from '../testing/upload-engine';

const SENTINEL = {
  supplement: 'Vexbramble',
  lab: 'Quillmarrow',
  labUnit: 'Glimmerunits',
  documentTitle: 'Tansyloft',
  fileName: 'Corvinashe',
  documentText: 'Halvorpine',
  documentMetadata: 'Mistlebrook',
  medication: 'Plumquist',
  chat: 'Brindlewick',
  chatAsked: 'Sorrelgate',
  chatAnswered: 'Fennimoor',
  email: 'wexmoth',
  uploadLab: 'Drovenquill',
  uploadUnit: 'Peltherunits',
} as const;
const WORDS = Object.values(SENTINEL);

/**
 * The day of the pressure readings. Not a sentinel: a date alone names no condition or result, so
 * a day may sit in an attribute (US-09 AC7l exemption). It is used only to find the Correct control.
 */
const BP_DAY = '2025-02-17T00:00:00.000Z';
/**
 * Each core metric's two readings (latest, earlier), unusual but in range, in SI. Each raw value
 * carries more digits than the screens show, so both forms are looked for: the shown one and the
 * raw stored one. A numeric sentinel matches only as a whole number, so the shown "5.4" would miss
 * a raw "5.43" in an attribute; the raw sentinel catches it. HDL shows one decimal, so its readings
 * are picked to show as numbers no icon drawing on these screens uses (5.1, 2.7).
 */
const CORE: ReadonlyArray<[metric: MetricType, latest: number, earlier: number]> = [
  ['weight', 138.64, 124.77], ['waist', 163.3, 146.6], ['hba1c', 109.4, 98.3], ['ldl', 11.83, 10.24],
  ['hdl', 5.137, 2.734], ['total_cholesterol', 13.62, 12.27], ['triglycerides', 17.34, 15.53],
  ['apob', 1.834, 1.648], ['creatinine', 1234.4, 1110.7], ['psa', 836.43, 752.71], ['lpa', 613.4, 551.6],
];
const shownSI = (metric: MetricType, value: number) => formatDisplayValue(metric, value, 'si');
const VALUES = [
  ...CORE.flatMap(([metric, latest, earlier]) => [latest, earlier].flatMap(v => [String(v), shownSI(metric, v)])),
  '187', '117', '191',
];
// Names, free text and values only. Not looked for (US-09 AC7l exemptions): a reading's day (a date
// alone names no condition or result), keys from fixed lists and the catalogue (the same for
// everyone), a form field's own value (the field is the field; the helper skips it) and a link in a
// document's own text (the link is the person's own; DOCUMENT_LINKS below).
const LOOKED_FOR = [...WORDS, ...VALUES];

vi.mock('chart.js', () => {
  class Chart { static register() {} destroy() {} update() {} }
  return { Chart, LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, TimeScale: {}, Tooltip: {}, Filler: {} };
});
vi.mock('chartjs-plugin-annotation', () => ({ default: {} }));
vi.mock('chartjs-adapter-date-fns', () => ({}));
vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  listConversations: vi.fn(async () => ({ conversations: [{ id: 'c1', title: 'Brindlewick question', updatedAt: '2026-10-20T00:00:00.000Z' }] })),
  loadConversation: vi.fn(async () => [
    { id: 'm1', role: 'user', content: 'What about Sorrelgate?', createdAt: '2026-10-20T00:00:00.000Z' },
    { id: 'm2', role: 'assistant', content: 'Fennimoor is **worth** asking about.', createdAt: '2026-10-20T00:00:01.000Z' },
  ]),
  sendMessage: vi.fn(() => new Promise(() => {})), deleteConversation: vi.fn(),
}));
vi.mock('../lib/chat-sync', () => ({ postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test' }));
vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));

import { HealthTool } from './HealthTool';
import { HistoryLightboxHost } from '../../standalone/history-lightbox';
import { RemindersControl } from '../../standalone/reminders-control';
// Loaded up front, so the lightbox's lazy import resolves without a bundler.
import './HistoryPanel';
import { trackLiveRefresh, stopLiveRefresh, showTables } from '../testing/health-tool-harness';
import { openSettings } from '../testing/settings';
import { checkLabImportQuota, labImport } from '../lib/upload-api';

configure({ asyncUtilTimeout: 5000 });

let phone = false;

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return q.includes('max-width') ? phone : !phone; }, media: q,
    addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  vi.stubGlobal('scrollTo', vi.fn());
  Element.prototype.scrollIntoView ??= () => {};
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
  trackLiveRefresh();
  await initRoadmapStore(new LocalStorageAdapter());
});
afterEach(async () => {
  cleanup();
  await new Promise(r => setTimeout(r, 20));
  history.replaceState(null, '');
  stopLiveRefresh();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** Every free-text field of the record holds its own sentinel, every core metric an unusual value. */
async function seed() {
  await saveChangedMeasurements({ sex: 'male', heightCm: 191, birthYear: 1975, birthMonth: 5, unitSystem: 'si' }, {}, getShownErase());
  for (const [metric, latest, earlier] of CORE) {
    await addMeasurement(metric, latest, '2026-10-12T00:00:00.000Z', getShownErase());
    await addMeasurement(metric, earlier, '2026-04-02T00:00:00.000Z', getShownErase());
  }
  await addMeasurement('systolic_bp', 187, BP_DAY, getShownErase());
  await addMeasurement('diastolic_bp', 117, BP_DAY, getShownErase());
  seedOpenLabValues([
    { metricName: SENTINEL.lab, value: 4.2, unit: SENTINEL.labUnit, recordedAt: '2026-10-12T00:00:00.000Z', source: 'manual' },
    { metricName: SENTINEL.lab, value: 3.9, unit: SENTINEL.labUnit, recordedAt: '2026-04-02T00:00:00.000Z', source: 'manual' },
  ]);
  const custom = customSupplementAdd(SENTINEL.supplement, []);
  await saveSupplement(custom.supplementKey, custom.supplementName, 5, 'mg', undefined, undefined, getShownErase());
  await saveMedication('statin', SENTINEL.medication, 20, 'mg', getShownErase());
  await seedOpenDocuments([{
    documentType: 'clinic_letter', title: SENTINEL.documentTitle, documentDate: '2026-10-01',
    // The letter's own link: its href is the person's own text, in their own document (exempt below).
    contentMd: `## ${SENTINEL.documentText}\n\nSee [the ${SENTINEL.documentText} notes](https://example.org/${SENTINEL.documentText}).`,
    metadata: { clinic: SENTINEL.documentMetadata }, sourceFileName: `${SENTINEL.fileName}.pdf`,
  }]);
  await flushRoadmapStore();
}

/** A link in a document's own text keeps its href: the person's link in their own document (US-09 AC7l). */
const DOCUMENT_LINKS = ['.doc-lightbox-content a[href]'];
const leaks = () => recordTextInAttributes(document.body, LOOKED_FOR, DOCUMENT_LINKS);
const shown = (word: string) => expect(document.body.textContent).toContain(word);
const settle = (ms = 20) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

describe('US-09 AC7l: the record\'s own text sits in no attribute on any main screen', () => {
  it('desktop: My data rows and grids, every value page, My health, a document, Settings and the chat', async () => {
    phone = false;
    await seed();
    render(<HealthTool />);
    await waitFor(() => expect(document.querySelector('.md-row')).not.toBeNull());
    await waitFor(() => shown(SENTINEL.supplement));
    shown(SENTINEL.lab);
    shown(shownSI('weight', 138.64));
    expect(leaks()).toEqual([]);

    // Each row's own page: its chart, latest value and history (a test the catalogue does not know among them).
    const rowNames = [...document.querySelectorAll<HTMLButtonElement>('.md-row')].map(b => b.textContent ?? '');
    let pressureSeen = false;
    for (const name of rowNames) {
      const rowButton = [...document.querySelectorAll<HTMLButtonElement>('.md-row')].find(b => b.textContent === name);
      if (!rowButton) continue;
      fireEvent.click(rowButton);
      await waitFor(() => expect(document.querySelector('.md-page')).not.toBeNull());
      await settle();
      expect({ page: name, leaks: leaks() }).toEqual({ page: name, leaks: [] });
      // A pressure's Correct is named after its reading's day, in the same words as before.
      if (document.querySelector('.md-history-bp')) {
        expect(screen.getByRole('button', { name: `Correct the reading of ${formatShortDate(BP_DAY)}` })).toBeTruthy();
        pressureSeen = true;
      }
      await act(async () => { history.back(); await new Promise(r => setTimeout(r, 20)); });
    }
    expect(pressureSeen).toBe(true);

    showTables();
    expect(leaks()).toEqual([]);

    // My health's documents, and one opened: its text shown, its own link kept.
    await waitFor(() => shown(SENTINEL.documentTitle));
    expect(leaks()).toEqual([]);
    const doc = [...document.querySelectorAll<HTMLButtonElement>('.health-record-item')].find(b => b.textContent?.includes(SENTINEL.documentTitle))!;
    fireEvent.click(doc);
    await waitFor(() => shown(SENTINEL.fileName));
    shown(SENTINEL.documentText);
    expect(document.querySelector('.doc-lightbox-content a')?.getAttribute('href')).toContain(SENTINEL.documentText);
    expect(leaks()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    openSettings();
    expect(leaks()).toEqual([]);

    // The chat column's thread list names the thread by its title; the thread opened shows both turns.
    await waitFor(() => shown(SENTINEL.chat));
    expect(leaks()).toEqual([]);
    fireEvent.click([...document.querySelectorAll<HTMLElement>('.chat-thread-item')].find(t => t.textContent?.includes(SENTINEL.chat))!);
    await waitFor(() => shown(SENTINEL.chatAnswered));
    shown(SENTINEL.chatAsked);
    expect(leaks()).toEqual([]);
  });

  it('the history lightbox: every chart, and LDL with its recorded medication changes', async () => {
    await seed();
    render(<HistoryLightboxHost />);
    act(() => { openHistoryLightbox(null); });
    await waitFor(() => shown(SENTINEL.lab), { timeout: 10_000 });
    expect(leaks()).toEqual([]);
    cleanup();
    render(<HistoryLightboxHost />);
    act(() => { openHistoryLightbox('ldl'); });
    await waitFor(() => expect(document.querySelector('.metric-chart-events')).not.toBeNull(), { timeout: 10_000 });
    expect(leaks()).toEqual([]);
  });

  it('phone: each tab', async () => {
    phone = true;
    await seed();
    render(<HealthTool />);
    await waitFor(() => expect(document.querySelector('.md-row')).not.toBeNull());
    for (const tab of screen.getAllByRole('tab')) {
      fireEvent.click(tab);
      await settle();
      expect({ tab: tab.textContent, leaks: leaks() }).toEqual({ tab: tab.textContent, leaks: [] });
    }
  });

  it('the reminders line names the address they go to, in no attribute', async () => {
    setReminderOptIn({ status: 'active', token: 'test-token-good', email: `${SENTINEL.email}@example.org`, provider: 'dropbox' }, getShownErase());
    render(<RemindersControl backend="dropbox" />);
    shown(SENTINEL.email);
    expect(leaks()).toEqual([]);
  });

  it('the upload review: a read test the catalogue does not know, its unit and the core values', async () => {
    await seed();
    vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
    vi.mocked(labImport).mockResolvedValue({ result: {
      classification: 'lab_report', document: null, reportDate: '2026-11-03',
      values: [{ metric: 'lpa', valueSI: 613.4, displayValue: 613.4, displayUnit: 'nmol/L', confidence: 'high' }],
      additionalValues: [{ name: SENTINEL.uploadLab, value: 4.4, unit: SENTINEL.uploadUnit }],
    } } as Awaited<ReturnType<typeof labImport>>);
    vi.stubGlobal('HealthUpload', { ...UPLOAD_ENGINE,
      extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false })),
      isPdf: () => true, isZip: () => false, isImage: () => false,
    });
    render(<HealthTool />);
    await waitFor(() => expect(document.querySelector('.md-row')).not.toBeNull());
    fireEvent.click((await screen.findAllByRole('button', { name: 'Upload labs' }))[0]);
    const keepless = screen.queryByRole('button', { name: /Continue without keeping the files/ });
    if (keepless) fireEvent.click(keepless);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], `${SENTINEL.fileName}.pdf`, { type: 'application/pdf' })] } });
    await waitFor(() => shown(SENTINEL.uploadLab), { timeout: 10_000 });
    const showAll = screen.queryByRole('button', { name: /^Show all/ });
    if (showAll) fireEvent.click(showAll);
    shown(SENTINEL.uploadUnit);
    expect(leaks()).toEqual([]);
  });
});
