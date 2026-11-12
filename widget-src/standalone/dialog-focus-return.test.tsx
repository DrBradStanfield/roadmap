// @vitest-environment jsdom
/**
 * US-09 AC34: the storage picker and the history lightbox give the keyboard
 * focus back to whatever opened them when they close.
 *
 * Both are native <dialog>s opened with showModal(), which moves the focus
 * inside. Closing one unmounts it, and a removed dialog (unlike one closed
 * with close()) gives the focus back to nothing: it lands on <body>, not on
 * the control the person used to open it.
 *
 * jsdom has no showModal, so the stub does the one part these tests need:
 * it moves the focus to the dialog's first button (its × here), as a browser does.
 */
import { StrictMode } from 'react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, fireEvent, cleanup, act, screen } from '@testing-library/react';

vi.mock('../src/storage', () => ({
  GoogleDriveAdapter: class {},
  GitHubAdapter: class {},
  WebDavAdapter: class {},
  isSyncPending: () => false,
  SYNC_PENDING_EVENT: 'hr:sync-pending',
  SAVE_STATUS_EVENT: 'hr:save-status',
  gisReady: () => true,
  preloadGis: () => undefined,
}));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', () => ({
  storageState: (backend: string) => (backend === 'local' ? 'guest' : 'cloud'),
  prepareSwitch: vi.fn(),
  liftLocalInto: vi.fn(),
  adapterFor: () => null,
  finishFormConnect: vi.fn(),
  logOff: vi.fn(),
  connectRefusal: () => null,
  rememberBackend: vi.fn(),
  forgetBackend: vi.fn(),
  useBusyRun: () => ({ busy: false, error: null, setError: vi.fn(), run: (fn: () => Promise<void>) => fn() }),
}));
// The chart panel itself is not under test: a stand-in keeps the lazy load instant.
vi.mock('../src/components/HistoryPanel', () => ({
  HistoryPanel: ({ initialMetric }: { initialMetric?: string }) => <p>History of {initialMetric}</p>,
}));

import { SyncControl } from './sync-control';
import { HistoryLightboxHost } from './history-lightbox';
import { openHistoryLightbox } from '../src/lib/roadmap-data';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    this.querySelector('button')?.focus();
  };
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => { cleanup(); });

const dialog = () => document.querySelector('dialog') as HTMLDialogElement | null;
const closeButton = () => dialog()!.querySelector('button.hr-modal-close') as HTMLButtonElement;

/** "View history" as InputPanel renders it: a link that fires hr:open-history. */
function HistoryLink() {
  return <a href="#history" onClick={(e) => { if (openHistoryLightbox('weight')) e.preventDefault(); }}>View history</a>;
}

async function openHistory() {
  render(<><HistoryLink /><HistoryLightboxHost /></>);
  const link = screen.getByText('View history');
  act(() => { link.focus(); });
  await act(async () => { fireEvent.click(link); });
  await screen.findByText('History of weight');
  return link;
}

describe('US-09 AC34: the history lightbox gives the focus back to its link', () => {
  it.each([
    ['the × button', () => fireEvent.click(closeButton())],
    ['Escape', () => fireEvent(dialog()!, new Event('cancel', { cancelable: true }))],
    ['a click on the backdrop', () => fireEvent.click(dialog()!)],
  ])('closed with %s', async (_how, close) => {
    const link = await openHistory();
    expect(document.activeElement).toBe(closeButton()); // showModal moved it inside
    act(() => { close(); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(link);
  });

  it('under React.StrictMode, as app.tsx mounts it, with the page behind the dialog inert', async () => {
    render(<StrictMode><HistoryLink /><HistoryLightboxHost /></StrictMode>);
    const link = screen.getByText('View history');
    // jsdom has no inert: while a modal dialog is open the link cannot take the
    // focus, as in a browser. StrictMode runs the effect twice on mount, so the
    // first cleanup's focus call must not count, and the second run must not
    // take the × for the opener.
    const focus = link.focus.bind(link);
    link.focus = () => { if (!document.querySelector('dialog[open]')) focus(); };
    act(() => { link.focus(); });
    await act(async () => { fireEvent.click(link); });
    await screen.findByText('History of weight');
    expect(document.activeElement).toBe(closeButton());
    act(() => { fireEvent.click(closeButton()); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(link);
  });
});

describe('US-09 AC34: the storage picker gives the focus back to the button that opened it', () => {
  it('opened from the provider name, closed with ×', () => {
    render(<SyncControl backend="dropbox" />);
    const provider = screen.getByRole('button', { name: 'Dropbox' });
    act(() => { provider.focus(); });
    act(() => { fireEvent.click(provider); });
    // The first focus is the picker's title (design re-check 2026-11-06), inside the dialog.
    expect(document.activeElement).toBe(dialog()!.querySelector('h2'));
    act(() => { fireEvent.click(closeButton()); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(provider);
  });

  it('closed with × after a provider is chosen, which re-renders it while open', () => {
    render(<SyncControl backend="dropbox" />);
    const provider = screen.getByRole('button', { name: 'Dropbox' });
    act(() => { provider.focus(); });
    act(() => { fireEvent.click(provider); });
    // Choosing GitHub swaps the list for its form: the picker re-renders, and
    // nothing inside it may become the element to give the focus back to.
    act(() => { closeButton().focus(); });
    act(() => { fireEvent.click(screen.getByText('GitHub')); });
    expect(screen.getByText('Connect GitHub', { selector: 'h2' })).toBeTruthy();
    expect(document.activeElement).toBe(closeButton());
    act(() => { fireEvent.click(closeButton()); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(provider);
  });

  it('closed with Escape', () => {
    render(<SyncControl backend="dropbox" />);
    const provider = screen.getByRole('button', { name: 'Dropbox' });
    act(() => { provider.focus(); });
    act(() => { fireEvent.click(provider); });
    expect(document.activeElement).toBe(dialog()!.querySelector('h2'));
    act(() => { fireEvent(dialog()!, new Event('cancel', { cancelable: true })); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(provider);
  });
});
