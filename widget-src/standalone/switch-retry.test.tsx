// @vitest-environment jsdom
/**
 * US-09 AC2g: a switch whose new connect failed can be tried again on the
 * same page.
 *
 * Leaving a connected cloud copies its record down to this browser and then
 * drops its tokens (prepareSwitch). A GitHub or self-host connect can then fail
 * on a mistyped token, owner or repository. Before this fix the corrected
 * second try ran the copy-down again, against a cloud whose tokens were already
 * gone, and was refused with "Dropbox could not be reached", however often the
 * user tried. Real picker, connect.ts, DropboxAdapter and GitHubAdapter;
 * only fetch, Sentry, product events and location.reload are fakes, and every
 * credential is synthetic.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

// A fresh module graph per test is a fresh page: whatever connect.ts keeps
// for the page's lifetime never carries from one test into the next.
let BackendPickerModal: typeof import('./backend-picker').BackendPickerModal;

const DROPBOX_TOKENS = 'health_roadmap_dropbox_tokens';
const GITHUB_CONFIG = 'health_roadmap_github';
const GOOD_TOKEN = 'github_pat_SYNTHETIC_GOOD';
const TYPO_TOKEN = 'github_pat_SYNTHETIC_TYPO';

let fetchCalls: string[];
let reload: ReturnType<typeof vi.fn>;

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  fetchCalls.push(url);
  // Dropbox: the record is not there yet, so the copy-down has nothing to merge.
  if (url.startsWith('https://content.dropboxapi.com/2/files/download')) {
    return Promise.resolve(new Response(JSON.stringify({ error_summary: 'path/not_found/..' }), { status: 409 }));
  }
  if (url.startsWith('https://api.github.com/repos/someone/health')) {
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (!auth.includes(GOOD_TOKEN)) return Promise.resolve(new Response('{"message":"Bad credentials"}', { status: 401 }));
    if (url === 'https://api.github.com/repos/someone/health') {
      return Promise.resolve(new Response(JSON.stringify({ private: true }), { status: 200 }));
    }
    return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
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
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'dropbox');
  localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({
    accessToken: 'sl.SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: Date.now() + 3_600_000,
  }));
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function connectGitHub(view: ReturnType<typeof render>, token: string): Promise<void> {
  const { getByPlaceholderText, getByRole } = view;
  fireEvent.change(getByPlaceholderText(/Fine-grained token/), { target: { value: token } });
  fireEvent.change(getByPlaceholderText(/Owner/), { target: { value: 'someone' } });
  fireEvent.change(getByPlaceholderText(/Repository name/), { target: { value: 'health' } });
  await act(async () => {
    fireEvent.click(getByRole('button', { name: 'Connect GitHub' }));
  });
}

describe('US-09 AC2g: switching from Dropbox to GitHub after a mistyped token', () => {
  it('a corrected second try connects GitHub instead of blaming Dropbox', async () => {
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));

    await connectGitHub(view, TYPO_TOKEN);
    await vi.waitFor(() => expect(view.container.ownerDocument.querySelector('.hr-sync-error')).not.toBeNull());
    // The first try copied the record down and signed out of Dropbox, as designed.
    expect(localStorage.getItem(DROPBOX_TOKENS)).toBeNull();
    expect(reload).not.toHaveBeenCalled();

    await connectGitHub(view, GOOD_TOKEN);
    const errorText = () => document.querySelector('.hr-sync-error')?.textContent ?? '';
    await vi.waitFor(() => expect(reload.mock.calls.length > 0 || errorText() !== '').toBe(true));
    expect(errorText()).not.toMatch(/Dropbox could not be reached/);
    expect(errorText()).toBe('');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(GITHUB_CONFIG) ?? 'null')).toMatchObject({ token: GOOD_TOKEN, owner: 'someone', repo: 'health' });
    expect(localStorage.getItem('health_roadmap_backend')).toBe('github');
    // The record was copied down once, by the first try.
    expect(fetchCalls.filter((u) => u.startsWith('https://content.dropboxapi.com/2/files/download'))).toHaveLength(1);
  });

  it('the retry still drops Dropbox tokens that a late refresh wrote back', async () => {
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    await connectGitHub(view, TYPO_TOKEN);
    await vi.waitFor(() => expect(document.querySelector('.hr-sync-error')).not.toBeNull());
    // The page's live Dropbox adapter refreshed its access token meanwhile and saved it.
    localStorage.setItem(DROPBOX_TOKENS, JSON.stringify({
      accessToken: 'sl.SYNTHETIC_ACCESS_2', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: Date.now() + 3_600_000,
    }));
    await connectGitHub(view, GOOD_TOKEN);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(DROPBOX_TOKENS)).toBeNull();
  });

  it('control: the first try still copies Dropbox down before it signs out', async () => {
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    await connectGitHub(view, TYPO_TOKEN);
    await vi.waitFor(() => expect(document.querySelector('.hr-sync-error')).not.toBeNull());
    expect(fetchCalls.filter((u) => u.startsWith('https://content.dropboxapi.com/2/files/download'))).toHaveLength(1);
    expect(document.querySelector('.hr-sync-error')?.textContent).not.toMatch(/Dropbox could not be reached/);
  });

  it('control: a Dropbox that cannot be read still stops the first switch and keeps its tokens (US-09 AC13)', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://content.dropboxapi.com/')) return Promise.reject(new TypeError('Failed to fetch'));
      return fakeFetch(input, init);
    }));
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    await connectGitHub(view, GOOD_TOKEN);
    await vi.waitFor(() => expect(document.querySelector('.hr-sync-error')?.textContent).toMatch(/Dropbox could not be reached/));
    expect(localStorage.getItem(DROPBOX_TOKENS)).not.toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('an unreadable Dropbox still stops a second try and keeps its tokens (US-09 AC13)', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://content.dropboxapi.com/')) {
        fetchCalls.push(url);
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return fakeFetch(input, init);
    }));
    const downloads = () => fetchCalls.filter((u) => u.startsWith('https://content.dropboxapi.com/2/files/download')).length;
    const errorText = () => document.querySelector('.hr-sync-error')?.textContent ?? '';
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));

    await connectGitHub(view, GOOD_TOKEN);
    await vi.waitFor(() => expect(errorText()).toMatch(/Dropbox could not be reached/));
    const firstReads = downloads();
    expect(firstReads).toBeGreaterThan(0);

    // A first try that stopped must not let the second one skip the copy-down:
    // this browser still does not hold the record.
    await connectGitHub(view, GOOD_TOKEN);
    await vi.waitFor(() => expect(downloads()).toBeGreaterThan(firstReads));
    await vi.waitFor(() => expect(errorText()).toMatch(/Dropbox could not be reached/));
    expect(localStorage.getItem(DROPBOX_TOKENS)).not.toBeNull();
    expect(localStorage.getItem(GITHUB_CONFIG)).toBeNull();
    expect(localStorage.getItem('health_roadmap_backend')).toBe('dropbox');
    expect(reload).not.toHaveBeenCalled();
  });
});
