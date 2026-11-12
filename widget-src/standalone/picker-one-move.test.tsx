// @vitest-environment jsdom
/**
 * US-09 AC45: the cloud picker runs one move at a time. While a connect, a
 * move or a log-off runs, closing and reopening the picker shows it running,
 * and no second one can start.
 *
 * Real picker, connect.ts, the store and the storage adapters; only fetch,
 * Sentry, product events and location.reload are fakes. The picker is mounted
 * only while open, as SyncControl mounts it. Every credential is synthetic.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

// A fresh module graph per test is a fresh page.
let BackendPickerModal: typeof import('./backend-picker').BackendPickerModal;

const BACKEND_KEY = 'health_roadmap_backend';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const GOOD_TOKEN = 'test-token-good';
const GOOD_PASSWORD = 'test-pass-good';
const DAV_URL = 'https://dav.example.test/health/';

let fetchCalls: string[];
let reload: ReturnType<typeof vi.fn>;
let holdGitHub: Promise<void> | null;
let holdDropbox: Promise<void> | null;
let holdDav: Promise<void> | null;
let dropboxFails: boolean;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  fetchCalls.push(url);
  if (url.startsWith('https://content.dropboxapi.com/2/files/download')) {
    if (holdDropbox) await holdDropbox;
    if (dropboxFails) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ error_summary: 'path/not_found/..' }), { status: 409 });
  }
  if (url.startsWith('https://api.github.com/repos/someone/health')) {
    if (holdGitHub) await holdGitHub;
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (!auth.includes(GOOD_TOKEN)) return new Response('{"message":"Bad credentials"}', { status: 401 });
    if (url === 'https://api.github.com/repos/someone/health') {
      return new Response(JSON.stringify({ private: true }), { status: 200 });
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  }
  if (url.startsWith(DAV_URL)) {
    if (holdDav) await holdDav;
    return new Response('', { status: init?.method === 'PROPFIND' ? 207 : 404 });
  }
  throw new Error(`unexpected fetch ${url}`);
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = vi.fn();
});

beforeEach(async () => {
  vi.resetModules();
  ({ BackendPickerModal } = await import('./backend-picker'));
  localStorage.clear();
  localStorage.setItem(BACKEND_KEY, 'dropbox');
  localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({
    accessToken: 'sl.SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: Date.now() + 3_600_000,
  }));
  fetchCalls = [];
  holdGitHub = null;
  holdDropbox = null;
  holdDav = null;
  dropboxFails = false;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true, configurable: true });
}, 30_000); // a fresh module graph per test: slow to import on a loaded machine

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** SyncControl's shape: the picker is mounted only while open. */
function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open-picker</button>
      {open && <BackendPickerModal current="dropbox" onClose={() => setOpen(false)} />}
    </>
  );
}

type View = ReturnType<typeof render>;
const open = (view: View) => fireEvent.click(view.getByRole('button', { name: 'open-picker' }));
const optionButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button.hr-opt'));
const logOffLink = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Log off this device');
const errorText = () => document.querySelector('.hr-sync-error')?.textContent ?? '';
const downloads = () => fetchCalls.filter((u) => u.startsWith('https://content.dropboxapi.com/2/files/download')).length;
const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 50)); });

async function startGitHubConnect(view: View): Promise<void> {
  fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
  fireEvent.change(view.getByPlaceholderText(/Fine-grained token/), { target: { value: GOOD_TOKEN } });
  fireEvent.change(view.getByPlaceholderText(/Owner/), { target: { value: 'someone' } });
  fireEvent.change(view.getByPlaceholderText(/Repository name/), { target: { value: 'health' } });
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Connect GitHub' })); });
}

async function startDriveSwitch(view: View): Promise<void> {
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /^Google Drive/ })); });
}

const CLOSE_WAYS: [string, (view: View) => void][] = [
  ['the × button', (view) => fireEvent.click(view.getByRole('button', { name: 'Close' }))],
  ['Escape', () => fireEvent(document.querySelector('dialog')!, new Event('cancel', { cancelable: true }))],
  ['a backdrop click', () => fireEvent.click(document.querySelector('dialog')!)],
];

function close(view: View, how: (view: View) => void = CLOSE_WAYS[0][1]): void {
  how(view);
  expect(view.queryByRole('button', { name: 'Close' })).toBeNull(); // really unmounted
}

/** Every way a reopened picker offers to start a GitHub connect or a log-off. */
async function tryAnotherMove(view: View): Promise<void> {
  const back = view.queryByRole('button', { name: '← Back' });
  if (back) fireEvent.click(back);
  const github = view.getByRole('button', { name: /^GitHub/ }) as HTMLButtonElement;
  if (!github.disabled) await startGitHubConnect(view);
  else fireEvent.click(github);
  const link = logOffLink();
  if (link && !link.disabled) {
    fireEvent.click(link);
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Log off' })); });
  }
}

describe('US-09 AC45: a reopened picker starts no second move', () => {
  it.each(CLOSE_WAYS)('closed with %s: one copy-down, one disconnect, one reload', async (_name, how) => {
    const dbx = deferred();
    holdDropbox = dbx.promise;
    const { DropboxAdapter } = await import('../src/storage/dropbox');
    const disconnects = vi.spyOn(DropboxAdapter.prototype, 'disconnect');
    const view = render(<Host />);
    open(view);
    await startGitHubConnect(view);
    await vi.waitFor(() => expect(downloads()).toBe(1));
    close(view, how);

    open(view);
    await tryAnotherMove(view);
    await settle();

    dbx.resolve();
    await vi.waitFor(() => expect(reload.mock.calls.length).toBeGreaterThanOrEqual(1));
    await settle();
    expect({ downloads: downloads(), dropboxDisconnects: disconnects.mock.calls.length, reloads: reload.mock.calls.length })
      .toEqual({ downloads: 1, dropboxDisconnects: 1, reloads: 1 });
    expect(localStorage.getItem(BACKEND_KEY)).toBe('github');
  });
});

describe('US-09 AC45: a move that fails while the picker is closed', () => {
  it('shows its error on reopen, and every choice is enabled again', async () => {
    const dbx = deferred();
    holdDropbox = dbx.promise;
    dropboxFails = true;
    const view = render(<Host />);
    open(view);
    await startDriveSwitch(view);
    await vi.waitFor(() => expect(downloads()).toBe(1));
    close(view);

    dbx.resolve();
    await settle();
    open(view);
    expect(errorText()).toMatch(/Dropbox could not be reached/);
    expect(optionButtons()).toHaveLength(5);
    expect(optionButtons().every((b) => !b.disabled)).toBe(true);
    expect(logOffLink()?.disabled).toBe(false);
    expect(localStorage.getItem(DROPBOX_TOKENS)).not.toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('US-09 AC45: a picker reopened while a move runs shows it running', () => {
  it('a GitHub connect: the form reads "Connecting…", and the list behind it is disabled', async () => {
    holdGitHub = deferred().promise;
    const view = render(<Host />);
    open(view);
    await startGitHubConnect(view);
    close(view);

    open(view);
    const running = view.getByRole('button', { name: 'Connecting…' }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    fireEvent.click(view.getByRole('button', { name: '← Back' }));
    expect(optionButtons()).toHaveLength(5);
    expect(optionButtons().every((b) => b.disabled)).toBe(true);
    expect(logOffLink()?.disabled).toBe(true);
  });

  it('a self-host connect: the form reads "Connecting…"', async () => {
    holdDav = deferred().promise;
    const view = render(<Host />);
    open(view);
    fireEvent.click(view.getByRole('button', { name: /^Your own server/ }));
    fireEvent.change(view.getByPlaceholderText(/WebDAV folder URL/), { target: { value: DAV_URL } });
    fireEvent.change(view.getByPlaceholderText(/Username/), { target: { value: 'someone' } });
    fireEvent.change(view.getByPlaceholderText(/Password/), { target: { value: GOOD_PASSWORD } });
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Connect' })); });
    close(view);

    open(view);
    expect((view.getByRole('button', { name: 'Connecting…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a move from the list: every choice and Log off are disabled', async () => {
    holdDropbox = deferred().promise;
    const view = render(<Host />);
    open(view);
    await startDriveSwitch(view);
    close(view);

    open(view);
    expect(optionButtons()).toHaveLength(5);
    expect(optionButtons().every((b) => b.disabled)).toBe(true);
    expect(logOffLink()?.disabled).toBe(true);
  });

  it('a log-off: the picker opens at it, reading "Logging off…"', async () => {
    const view = render(<Host />);
    open(view);
    fireEvent.click(logOffLink()!);
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Log off' })); });
    close(view);

    open(view);
    expect((view.getByRole('button', { name: 'Logging off…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('US-09 AC45: the shared move state never holds a credential (Q5)', () => {
  it('no state reached in a GitHub or a self-host connect holds the token or the password', async () => {
    const flow = await import('./switch-flow');
    const seen: string[] = [JSON.stringify(flow.getSwitchFlow())];
    const stop = flow.subscribeSwitchFlow(() => seen.push(JSON.stringify(flow.getSwitchFlow())));
    try {
      const view = render(<Host />);
      open(view);
      await startGitHubConnect(view);
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      cleanup();
      flow.resetSwitchFlow();

      const second = render(<Host />);
      open(second);
      fireEvent.click(second.getByRole('button', { name: /^Your own server/ }));
      fireEvent.change(second.getByPlaceholderText(/WebDAV folder URL/), { target: { value: DAV_URL } });
      fireEvent.change(second.getByPlaceholderText(/Username/), { target: { value: 'someone' } });
      fireEvent.change(second.getByPlaceholderText(/Password/), { target: { value: GOOD_PASSWORD } });
      await act(async () => { fireEvent.click(second.getByRole('button', { name: 'Connect' })); });
      await settle();
    } finally {
      stop();
    }
    expect(seen.some((s) => s.includes('"github"'))).toBe(true);
    expect(seen.some((s) => s.includes('"self-host"'))).toBe(true);
    for (const s of seen) expect(s).not.toMatch(/test-token-good|test-pass-good/);
  });
});

describe('US-09 AC45: a page the browser shows again from its back-forward cache', () => {
  function pageshow(persisted: boolean): void {
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: persisted });
    act(() => { window.dispatchEvent(event); });
  }

  async function connectGitHubThenClose(view: View): Promise<void> {
    open(view);
    await startGitHubConnect(view);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    close(view);
  }

  it('after a move, the reopened picker offers every choice and Log off again', async () => {
    const view = render(<Host />);
    await connectGitHubThenClose(view);
    pageshow(true);

    open(view);
    expect(optionButtons()).toHaveLength(5);
    expect(optionButtons().every((b) => !b.disabled)).toBe(true);
    expect(logOffLink()?.disabled).toBe(false);
    expect(errorText()).toBe('');
  });

  it('while a GitHub connect still waits on its repository check, the picker stays claimed and that connect ends alone', async () => {
    const gh = deferred();
    holdGitHub = gh.promise;
    const view = render(<Host />);
    open(view);
    await startGitHubConnect(view);
    await vi.waitFor(() => expect(fetchCalls.some((u) => u.startsWith('https://api.github.com/'))).toBe(true));
    close(view);
    pageshow(true);

    open(view);
    expect((view.getByRole('button', { name: 'Connecting…' }) as HTMLButtonElement).disabled).toBe(true);
    await tryAnotherMove(view);
    gh.resolve();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(downloads()).toBe(1);
    expect(localStorage.getItem(BACKEND_KEY)).toBe('github');
  });

  it('control: a first page show leaves the move running', async () => {
    const view = render(<Host />);
    await connectGitHubThenClose(view);
    pageshow(false);

    open(view);
    expect(view.getByRole('button', { name: 'Connecting…' })).toBeTruthy();
  });
});
