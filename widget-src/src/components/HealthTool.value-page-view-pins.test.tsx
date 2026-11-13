// @vitest-environment jsdom
/**
 * Pins for My data's view state (lib/useValuePage, US-62 AC10, AC11, US-16 AC2):
 * the paths the value-page and table tests elsewhere leave open, written
 * against main before the view became one union. A phone: rows, a value page
 * over them, the table under them, a chat edit that reveals a cell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEditTarget } from '../hooks/useChatState';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ProposedEdit } from '@roadmap/health-core/chat-edits';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';

const chat = vi.hoisted(() => ({ proposeEdit: null as null | ((edits: ProposedEdit[]) => void) }));
vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({
  ChatEmbed: ({ onProposeEdit }: { onProposeEdit: ChatEditTarget }) => {
    chat.proposeEdit = (edits) => onProposeEdit.take(edits, onProposeEdit.ask(), true); // asked and answered at once
    return null;
  },
}));
import { HealthTool } from './HealthTool';

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  chat.proposeEdit = null;
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  vi.stubGlobal('scrollTo', vi.fn());
  Element.prototype.scrollIntoView = () => {};
  await initRoadmapStore(new LocalStorageAdapter());
});
afterEach(async () => {
  cleanup();
  // jsdom keeps one history for the file: let a pending back land, then start the next test on a plain entry.
  await new Promise(r => setTimeout(r, 20));
  history.replaceState(null, '');
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

type View = ReturnType<typeof render>;
async function renderTool(): Promise<View> {
  await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1975, birthMonth: 5, unitSystem: 'si' }, {});
  await addMeasurement('weight', 82, '2026-09-01');
  await addMeasurement('ldl', 3.0, '2026-09-01');
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
  await waitFor(() => expect(row(view, 'LDL Cholesterol')).toBeTruthy());
  return view;
}
const row = (view: View, name: string) =>
  [...view.container.querySelectorAll<HTMLButtonElement>('.md-row')].find(b => b.querySelector('.md-row-label')?.textContent === name)!;
const page = (view: View) => view.container.querySelector<HTMLElement>('.mh-page-host .md-page');
const table = (view: View) => view.container.querySelector<HTMLElement>('.md-table')!;
const messages = (view: View) => view.container.querySelector('.md-panel-messages')!.textContent;
const chatLdl = () => act(() => chat.proposeEdit!([{ kind: 'field', field: 'ldlC', displayValue: 3.2, unitSystem: 'si', date: null }]));

describe('US-16 AC2: a chat edit over an open value page', () => {
  it('with nothing typed, the page closes without a word, its history entry goes, and the grid cell shows', async () => {
    const view = await renderTool();
    fireEvent.click(row(view, 'LDL Cholesterol'));
    expect(page(view)).not.toBeNull();
    expect(history.state?.hrValuePage).toBe(true);
    chatLdl();
    await waitFor(() => expect(page(view)).toBeNull());
    await waitFor(() => expect(history.state?.hrValuePage).toBeFalsy());
    expect(table(view).hidden).toBe(false);
    await new Promise(r => setTimeout(r, 50));
    expect(messages(view)!.trim()).toBe(''); // the live region holds a space, never the not-saved line
  });

  it('after the reveal a row press opens its page again; Back returns to the rows with the table shut', async () => {
    const view = await renderTool();
    fireEvent.click(row(view, 'LDL Cholesterol'));
    chatLdl();
    await waitFor(() => expect(page(view)).toBeNull());
    expect(table(view).hidden).toBe(false);
    await new Promise(r => setTimeout(r, 20));
    fireEvent.click(row(view, 'Weight'));
    expect(page(view)).not.toBeNull();
    expect(history.state?.hrValuePage).toBe(true);
    fireEvent.click(within(page(view)!).getByRole('button', { name: '‹ Back' }));
    await waitFor(() => expect(page(view)).toBeNull());
    expect(table(view).hidden).toBe(true); // the reveal showed it; the press moved on from the reveal
  });

  it('after the reveal "Show as rows" shuts the table, and it stays shut', async () => {
    const view = await renderTool();
    chatLdl();
    await waitFor(() => expect(table(view).hidden).toBe(false));
    fireEvent.click(within(table(view)).getByRole('button', { name: '‹ Show as rows' }));
    expect(table(view).hidden).toBe(true);
    await new Promise(r => setTimeout(r, 20));
    expect(table(view).hidden).toBe(true);
    expect(row(view, 'LDL Cholesterol')).toBeTruthy();
  });
});

describe('US-62 AC11: the table is a toggle beside the page', () => {
  it('opened, then a page opened from a row and closed: the table is still shown', async () => {
    const view = await renderTool();
    fireEvent.click(view.getByRole('button', { name: 'All results as a table' }));
    expect(table(view).hidden).toBe(false);
    fireEvent.click(row(view, 'Weight'));
    expect(page(view)).not.toBeNull();
    fireEvent.click(within(page(view)!).getByRole('button', { name: '‹ Back' }));
    await waitFor(() => expect(page(view)).toBeNull());
    expect(table(view).hidden).toBe(false);
    fireEvent.click(within(table(view)).getByRole('button', { name: '‹ Show as rows' }));
    expect(table(view).hidden).toBe(true);
  });
});

describe('US-62 AC10: typed input and Back', () => {
  it('the browser back with typed input, accepted: the page closes and its entry is gone', async () => {
    const view = await renderTool();
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    fireEvent.click(row(view, 'LDL Cholesterol'));
    fireEvent.change(within(page(view)!).getByLabelText(/Value/), { target: { value: '2.2' } });
    act(() => { history.back(); });
    await waitFor(() => expect(page(view)).toBeNull());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(history.state?.hrValuePage).toBeFalsy();
  });

  it('"‹ Back" with typed input, declined: the page, its typing and its entry stay; nothing typed asks nothing', async () => {
    const view = await renderTool();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    fireEvent.click(row(view, 'LDL Cholesterol'));
    fireEvent.change(within(page(view)!).getByLabelText(/Value/), { target: { value: '2.2' } });
    fireEvent.click(within(page(view)!).getByRole('button', { name: '‹ Back' }));
    expect(confirm).toHaveBeenCalledWith('Leave without saving the value you typed?');
    await new Promise(r => setTimeout(r, 20));
    expect((within(page(view)!).getByLabelText(/Value/) as HTMLInputElement).value).toBe('2.2');
    expect(history.state?.hrValuePage).toBe(true);
    fireEvent.change(within(page(view)!).getByLabelText(/Value/), { target: { value: '' } });
    fireEvent.click(within(page(view)!).getByRole('button', { name: '‹ Back' }));
    await waitFor(() => expect(page(view)).toBeNull());
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
