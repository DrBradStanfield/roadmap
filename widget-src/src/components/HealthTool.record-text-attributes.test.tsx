// @vitest-environment jsdom
/**
 * US-09 AC7l, across the whole widget: text from the person's record is shown as text, never
 * copied into an attribute. A record whose every free-text field holds its own made-up word is
 * rendered through the real HealthTool and store, and each main screen is walked: My data (rows,
 * a value page with its chart, the grids), My health with its documents and a document opened,
 * Settings, the chat column's thread list, the history lightbox and each phone tab. The medication's
 * free text is in the record though no screen shows it (a drug off the list is named by its class).
 * Synthetic record; the chat's network is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { customSupplementAdd } from '@roadmap/health-core/input-form';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import {
  addMeasurement, bulkSaveDocuments, bulkSaveLabValues, flushRoadmapStore, initRoadmapStore, openHistoryLightbox, saveChangedMeasurements, saveMedication, saveSupplement,
} from '../lib/roadmap-data';
import { recordTextInAttributes } from '../testing/no-record-text-in-attributes';

const SENTINEL = {
  supplement: 'Vexbramble',
  lab: 'Quillmarrow',
  documentTitle: 'Tansyloft',
  fileName: 'Corvinashe',
  medication: 'Plumquist',
  chat: 'Brindlewick',
} as const;
const WORDS = Object.values(SENTINEL);

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
  loadConversation: vi.fn(async () => []), sendMessage: vi.fn(() => new Promise(() => {})), deleteConversation: vi.fn(),
}));
vi.mock('../lib/chat-sync', () => ({ postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test' }));

import { HealthTool } from './HealthTool';
import { HistoryLightboxHost } from '../../standalone/history-lightbox';
// Loaded up front, so the lightbox's lazy import resolves without a bundler.
import './HistoryPanel';
import { trackLiveRefresh, stopLiveRefresh, showTables } from '../testing/health-tool-harness';
import { openSettings } from '../testing/settings';

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

/** Every free-text field of the record holds its own sentinel. */
async function seed() {
  await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1975, birthMonth: 5, unitSystem: 'si' }, {});
  await addMeasurement('ldl', 3.4, '2026-10-12T00:00:00.000Z');
  await addMeasurement('ldl', 2.9, '2026-04-02T00:00:00.000Z');
  await bulkSaveLabValues([
    { metricName: SENTINEL.lab, value: 4.2, unit: 'U/L', recordedAt: '2026-10-12T00:00:00.000Z', source: 'manual' },
    { metricName: SENTINEL.lab, value: 3.9, unit: 'U/L', recordedAt: '2026-04-02T00:00:00.000Z', source: 'manual' },
  ]);
  const custom = customSupplementAdd(SENTINEL.supplement, []);
  await saveSupplement(custom.supplementKey, custom.supplementName, 5, 'mg');
  await saveMedication('statin', SENTINEL.medication, 20, 'mg');
  await bulkSaveDocuments([{
    documentType: 'clinic_letter', title: SENTINEL.documentTitle, documentDate: '2026-10-01', contentMd: 'Plan', metadata: {},
    sourceFileName: `${SENTINEL.fileName}.pdf`,
  }]);
  await flushRoadmapStore();
}

const leaks = () => recordTextInAttributes(document.body, WORDS);
const shown = (word: string) => expect(document.body.textContent).toContain(word);

describe('US-09 AC7l: the record\'s own text sits in no attribute on any main screen', () => {
  it('desktop: My data rows and grids, a value page, My health, a document, Settings and the chat History', async () => {
    phone = false;
    await seed();
    render(<HealthTool />);
    await waitFor(() => expect(document.querySelector('.md-row')).not.toBeNull());
    await waitFor(() => shown(SENTINEL.supplement));
    shown(SENTINEL.lab);
    expect(leaks()).toEqual([]);

    // The test the catalogue does not know, on its own page: its chart is named after it.
    const labRow = [...document.querySelectorAll<HTMLButtonElement>('.md-row')].find(b => b.textContent?.includes(SENTINEL.lab))!;
    fireEvent.click(labRow);
    await waitFor(() => expect(document.querySelector('.md-page canvas')).not.toBeNull());
    expect(leaks()).toEqual([]);
    await act(async () => { history.back(); await new Promise(r => setTimeout(r, 20)); });

    showTables();
    expect(leaks()).toEqual([]);

    // My health's documents, and one opened.
    await waitFor(() => shown(SENTINEL.documentTitle));
    expect(leaks()).toEqual([]);
    const doc = [...document.querySelectorAll<HTMLButtonElement>('.health-record-item')].find(b => b.textContent?.includes(SENTINEL.documentTitle))!;
    fireEvent.click(doc);
    await waitFor(() => shown(SENTINEL.fileName));
    expect(leaks()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    openSettings();
    expect(leaks()).toEqual([]);

    // The chat column's thread list names the thread by its title.
    await waitFor(() => shown(SENTINEL.chat));
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
      await act(async () => { await new Promise(r => setTimeout(r, 20)); });
      expect({ tab: tab.textContent, leaks: leaks() }).toEqual({ tab: tab.textContent, leaks: [] });
    }
  });
});
