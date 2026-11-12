// @vitest-environment jsdom
/**
 * US-09: pins on the storage picker as it behaves today.
 *
 * While a connect or a log-off runs, its button names what is happening and
 * the other choices cannot be pressed. Choosing the provider that is already
 * connected only closes the picker. Real picker, connect.ts and the storage
 * adapters; only fetch, Sentry, product events and location.reload are fakes,
 * and every credential is synthetic.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

// A fresh module graph per test is a fresh page.
let BackendPickerModal: typeof import('./backend-picker').BackendPickerModal;
let trackProductEvent: ReturnType<typeof vi.fn>;

const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const GITHUB_CONFIG = 'health_roadmap_github';
const GOOD_TOKEN = 'test-token-good';

let fetchCalls: string[];
let reload: ReturnType<typeof vi.fn>;
/** Dropbox reads wait here until the test answers them. */
let heldReads: { reject: (e: Error) => void }[];

function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  fetchCalls.push(url);
  if (url.startsWith('https://content.dropboxapi.com/2/files/download')) {
    return new Promise<Response>((_resolve, reject) => { heldReads.push({ reject }); });
  }
  return Promise.reject(new Error(`unexpected fetch ${url}`));
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = vi.fn();
});

beforeEach(async () => {
  vi.resetModules();
  ({ BackendPickerModal } = await import('./backend-picker'));
  trackProductEvent = (await import('../src/lib/server-api')).trackProductEvent as unknown as ReturnType<typeof vi.fn>;
  trackProductEvent.mockClear();
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'dropbox');
  localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({
    accessToken: 'sl.SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: Date.now() + 3_600_000,
  }));
  fetchCalls = [];
  heldReads = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true, configurable: true });
}, 30_000); // a fresh module graph per test: slow to import on a loaded machine

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const optionButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button.hr-opt'));
const logOffLink = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Log off this device');
const errorText = () => document.querySelector('.hr-sync-error')?.textContent ?? '';

/** Answer every held Dropbox read with a network failure. */
async function failHeldReads(): Promise<void> {
  await act(async () => {
    for (const read of heldReads.splice(0)) read.reject(new TypeError('Failed to fetch'));
  });
}

describe('US-09: while a connect or log-off runs, the picker shows it on one mount', () => {
  it('a connect from the list disables every choice and Log off until it ends; then Log off reads "Logging off…"', async () => {
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    expect(optionButtons()).toHaveLength(5);
    expect(optionButtons().every((b) => !b.disabled)).toBe(true);
    expect(logOffLink()?.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /^Google Drive/ }));
    });
    await vi.waitFor(() => expect(heldReads.length).toBeGreaterThan(0));
    // The copy-down from Dropbox is running.
    expect(optionButtons().every((b) => b.disabled)).toBe(true);
    expect(logOffLink()?.disabled).toBe(true);

    await failHeldReads();
    await vi.waitFor(() => expect(errorText()).toMatch(/Dropbox could not be reached/));
    expect(optionButtons().every((b) => !b.disabled)).toBe(true);
    expect(logOffLink()?.disabled).toBe(false);

    fireEvent.click(logOffLink()!);
    const logOffButton = view.getByRole('button', { name: 'Log off' }) as HTMLButtonElement;
    expect(logOffButton.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(logOffButton);
    });
    expect(logOffButton.textContent).toBe('Logging off…');
    expect(logOffButton.disabled).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DROPBOX_TOKENS)).toBeNull();
  });

  it('a GitHub connect reads "Connecting…" and is disabled until it ends', async () => {
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    fireEvent.change(view.getByPlaceholderText(/Fine-grained token/), { target: { value: GOOD_TOKEN } });
    fireEvent.change(view.getByPlaceholderText(/Owner/), { target: { value: 'someone' } });
    fireEvent.change(view.getByPlaceholderText(/Repository name/), { target: { value: 'health' } });
    const connect = view.getByRole('button', { name: 'Connect GitHub' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(connect);
    });
    await vi.waitFor(() => expect(heldReads.length).toBeGreaterThan(0));
    expect(connect.textContent).toBe('Connecting…');
    expect(connect.disabled).toBe(true);

    await failHeldReads();
    await vi.waitFor(() => expect(errorText()).toMatch(/Dropbox could not be reached/));
    expect(connect.textContent).toBe('Connect GitHub');
    expect(connect.disabled).toBe(false);
    expect(localStorage.getItem(GITHUB_CONFIG)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('US-09: choosing the provider that is already connected closes the picker', () => {
  it('Dropbox, when Dropbox is connected: closes, with nothing run', async () => {
    const onClose = vi.fn();
    const view = render(<BackendPickerModal current="dropbox" onClose={onClose} />);
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /^Dropbox/ }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalled();
    expect(localStorage.getItem(DROPBOX_TOKENS)).not.toBeNull();
    expect(localStorage.getItem('health_roadmap_backend')).toBe('dropbox');
    expect(optionButtons().every((b) => !b.disabled)).toBe(true);
    expect(errorText()).toBe('');
  });

  it('GitHub, when GitHub is connected: closes instead of opening the token form', async () => {
    localStorage.setItem('health_roadmap_backend', 'github');
    localStorage.setItem(GITHUB_CONFIG, JSON.stringify({ token: GOOD_TOKEN, owner: 'someone', repo: 'health' }));
    const onClose = vi.fn();
    const view = render(<BackendPickerModal current="github" onClose={onClose} />);
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(view.queryByPlaceholderText(/Fine-grained token/)).toBeNull();
    expect(fetchCalls).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(GITHUB_CONFIG) ?? 'null')).toMatchObject({ token: GOOD_TOKEN });
  });

  it('control: choosing a different provider does not close the picker', async () => {
    const onClose = vi.fn();
    const view = render(<BackendPickerModal current="dropbox" onClose={onClose} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    expect(onClose).not.toHaveBeenCalled();
    expect(view.getByPlaceholderText(/Fine-grained token/)).toBeTruthy();
  });
});
