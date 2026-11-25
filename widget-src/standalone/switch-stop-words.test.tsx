// @vitest-environment jsdom
/**
 * US-09 AC56: a stopped switch shows the sentence for its cause. Real picker, connect.ts and the Dropbox
 * adapter; only fetch, Sentry, product events and location are fakes. Synthetic credentials.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

let BackendPickerModal: typeof import('./backend-picker').BackendPickerModal;
const BACKEND_KEY = 'health_roadmap_backend';
const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
let reload: ReturnType<typeof vi.fn>;
let downloads: number;

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
  downloads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://content.dropboxapi.com/2/files/download')) {
      downloads += 1;
      throw new TypeError('Failed to fetch');
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload, assign: vi.fn() }, writable: true, configurable: true });
}, 30_000);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** From Dropbox, choose Google Drive; the switch stops before it leaves. */
async function switchToDrive(): Promise<string> {
  const view = render(<BackendPickerModal current="dropbox" onClose={() => {}} />);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /^Google Drive/ })); });
  await vi.waitFor(() => expect(document.querySelector('.hr-sync-error')?.textContent).toBeTruthy());
  return document.querySelector('.hr-sync-error')?.textContent ?? '';
}

describe('US-09 AC56: the stopped switch says why, one sentence per cause', () => {
  it('unreachable: Dropbox did not answer', async () => {
    expect(await switchToDrive()).toBe(
      'Dropbox could not be reached, so your record there could not be copied to this browser. Try again once it answers.',
    );
    expect(downloads).toBe(1);
  });

  it('signInRefused: this browser holds no Dropbox sign-in', async () => {
    localStorage.removeItem(DROPBOX_TOKENS);
    expect(await switchToDrive()).toBe('Dropbox did not connect, so nothing changed. Please try again.');
    expect(downloads).toBe(0);
  });

  it('writesRefused: another tab logged this browser off', async () => {
    vi.resetModules(); // the other tab: its own module graph, sharing this localStorage
    await (await import('./connect')).logOff('dropbox');
    expect(await switchToDrive()).toBe('This browser was logged off in another tab. Reload this page to carry on.');
    expect(reload).toHaveBeenCalledTimes(1); // the other tab's own reload, not this page's
  });
});
