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
 * user tried. The second describe keeps the page's live store on Dropbox:
 * its adapter still holds the token in memory after the first try, so what
 * the page saves or takes in between the tries must still reach the new cloud
 * (Brad's review, 2026-11-04). Real picker, connect.ts, the store,
 * DropboxAdapter and GitHubAdapter;
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
const GOOD_TOKEN = 'test-token-good';
const TYPO_TOKEN = 'test-token-typo';

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
}, 30_000); // a fresh module graph per test: slow to import on a loaded machine

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

// A Dropbox and a GitHub that keep what is written to them, so a test can read
// back where a value ended up. Every credential is synthetic.
const RECORD = 'health-roadmap.json';
let dropboxFile: { body: string; rev: number } | null;
let githubFile: { body: string; sha: number } | null;

function fakeClouds(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  fetchCalls.push(url);
  if (url === 'https://content.dropboxapi.com/2/files/download') {
    if (!dropboxFile) return Promise.resolve(new Response(JSON.stringify({ error_summary: 'path/not_found/..' }), { status: 409 }));
    return Promise.resolve(new Response(dropboxFile.body, {
      status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: `r${dropboxFile.rev}` }) },
    }));
  }
  if (url === 'https://content.dropboxapi.com/2/files/upload') {
    dropboxFile = { body: String(init?.body), rev: (dropboxFile?.rev ?? 0) + 1 };
    return Promise.resolve(new Response(JSON.stringify({ rev: `r${dropboxFile.rev}` }), { status: 200 }));
  }
  // The live page's change signal: held open, never answered.
  if (url.startsWith('https://api.dropboxapi.com/') || url.startsWith('https://notify.dropboxapi.com/')) {
    return new Promise<Response>(() => undefined);
  }
  if (url.startsWith('https://api.github.com/repos/someone/health')) {
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (!auth.includes(GOOD_TOKEN)) return Promise.resolve(new Response('{"message":"Bad credentials"}', { status: 401 }));
    if (url === 'https://api.github.com/repos/someone/health') {
      return Promise.resolve(new Response(JSON.stringify({ private: true }), { status: 200 }));
    }
    if (url.startsWith(`https://api.github.com/repos/someone/health/contents/${RECORD}`)) {
      if (init?.method === 'PUT') {
        const { content } = JSON.parse(String(init.body)) as { content: string };
        githubFile = { body: new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0))), sha: (githubFile?.sha ?? 0) + 1 };
        return Promise.resolve(new Response(JSON.stringify({ content: { sha: `s${githubFile.sha}` } }), { status: 201 }));
      }
      if (!githubFile) return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
      const bytes = new TextEncoder().encode(githubFile.body);
      return Promise.resolve(new Response(JSON.stringify({
        content: btoa(String.fromCharCode(...bytes)), sha: `s${githubFile.sha}`, encoding: 'base64', size: bytes.length,
      }), { status: 200 }));
    }
    return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
  }
  return Promise.reject(new Error(`unexpected fetch ${url}`));
}

/** What each cloud holds now (a function, so TypeScript does not narrow it to the reset). */
const dropboxBody = (): string | undefined => dropboxFile?.body;
const githubBody = (): string | undefined => githubFile?.body;

/** The weights a stored record holds, by day. */
function weightsIn(body: string | undefined): Record<string, number> {
  const file = JSON.parse(body ?? '{"measurements":[]}') as { measurements: { metricType: string; value: number; recordedAt: string }[] };
  return Object.fromEntries(file.measurements.filter((m) => m.metricType === 'weight').map((m) => [m.recordedAt.slice(0, 10), m.value]));
}

describe('US-09 AC2g: what the page saved between the two tries reaches the new cloud', () => {
  let data: typeof import('../src/lib/roadmap-data');
  let connect: typeof import('./connect');

  beforeEach(async () => {
    dropboxFile = null;
    githubFile = null;
    vi.stubGlobal('fetch', vi.fn(fakeClouds));
    data = await import('../src/lib/roadmap-data');
    connect = await import('./connect');
    // The page is on Dropbox: its live store saves through its own adapter.
    await data.initRoadmapStore(connect.adapterFor('dropbox')!);
    expect((await data.addMeasurement('weight', 80, '2026-01-01')).status).toBe('inserted');
    await data.flushRoadmapStore();
    expect(weightsIn(dropboxBody())).toEqual({ '2026-01-01': 80 });
  }, 30_000);

  afterEach(async () => {
    // The page this test left behind still holds an edit on the save's
    // debounce; land it now, or it would arrive in the next test's Dropbox.
    await data.flushRoadmapStore().catch(() => undefined);
  });

  it('a value logged after the refused token is in GitHub after the corrected try', async () => {
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    await connectGitHub(view, TYPO_TOKEN);
    await vi.waitFor(() => expect(document.querySelector('.hr-sync-error')).not.toBeNull(), { timeout: 10_000 });
    expect(localStorage.getItem(DROPBOX_TOKENS)).toBeNull();

    // The person logs another weight. The page's live Dropbox adapter still
    // holds its token in memory, so the save lands in Dropbox, not on the device.
    expect((await data.addMeasurement('weight', 79, '2026-01-02')).status).toBe('inserted');
    await data.flushRoadmapStore();
    expect(weightsIn(dropboxBody())).toEqual({ '2026-01-01': 80, '2026-01-02': 79 });

    await new Promise((done) => setTimeout(done, 5));
    const retryStarted = new Date().toISOString();
    await connectGitHub(view, GOOD_TOKEN);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(weightsIn(githubBody())).toEqual({ '2026-01-01': 80, '2026-01-02': 79 });
    const device = JSON.parse(localStorage.getItem('health_roadmap_file_v2') ?? '{}') as { meta: { updatedAt: string; lastDeviceId: string } };
    expect(weightsIn(JSON.stringify(device))).toEqual({ '2026-01-01': 80, '2026-01-02': 79 });
    // The retry wrote that device copy itself: as this device, at its own time.
    expect(device.meta.updatedAt >= retryStarted).toBe(true);
    expect(device.meta.lastDeviceId).toBe(localStorage.getItem('health_roadmap_device_id'));
    expect(localStorage.getItem(DROPBOX_TOKENS)).toBeNull();
  });

  it('a value not yet saved when the corrected try starts is in GitHub too', async () => {
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    await connectGitHub(view, TYPO_TOKEN);
    await vi.waitFor(() => expect(document.querySelector('.hr-sync-error')).not.toBeNull(), { timeout: 10_000 });

    // Still on the save's debounce when the person presses Connect again.
    expect((await data.addMeasurement('weight', 78, '2026-01-03')).status).toBe('inserted');
    await connectGitHub(view, GOOD_TOKEN);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(weightsIn(githubBody())).toMatchObject({ '2026-01-01': 80, '2026-01-03': 78 });
  });

  it('a value an assistant wrote to Dropbox, which the page took in between the tries, is in GitHub too', async () => {
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    await connectGitHub(view, TYPO_TOKEN);
    await vi.waitFor(() => expect(document.querySelector('.hr-sync-error')).not.toBeNull(), { timeout: 10_000 });

    // An assistant writes a weight into the Dropbox file; the page re-reads
    // it when the person comes back to the tab (US-34).
    const file = JSON.parse(dropboxFile!.body) as { measurements: Record<string, unknown>[]; meta: { updatedAt: string } };
    const at = new Date().toISOString();
    file.measurements.push({ ...file.measurements[0], id: 'assistant-row-1', value: 77, recordedAt: '2026-01-04T00:00:00.000Z', createdAt: at, updatedAt: at });
    file.meta.updatedAt = at;
    dropboxFile = { body: JSON.stringify(file), rev: dropboxFile!.rev + 1 };
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(async () => expect((await data.loadAllHistory()).some((m) => m.value === 77)).toBe(true), { timeout: 10_000 });

    await connectGitHub(view, GOOD_TOKEN);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(weightsIn(githubBody())).toEqual({ '2026-01-01': 80, '2026-01-04': 77 });
  });

  it('a device that refuses the copy stops the corrected try before GitHub', async () => {
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    await connectGitHub(view, TYPO_TOKEN);
    await vi.waitFor(() => expect(document.querySelector('.hr-sync-error')).not.toBeNull(), { timeout: 10_000 });
    expect((await data.addMeasurement('weight', 79, '2026-01-02')).status).toBe('inserted');
    await data.flushRoadmapStore();

    // This browser's storage is full now: the record cannot be copied onto it.
    const setItem = Storage.prototype.setItem;
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('health_roadmap_file_v2')) throw new DOMException('synthetic quota', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    try {
      await connectGitHub(view, GOOD_TOKEN);
      await vi.waitFor(() => expect(document.querySelector('.hr-sync-error')?.textContent).toMatch(/could not be copied to this browser/), { timeout: 10_000 });
    } finally {
      full.mockRestore();
    }
    expect(githubFile).toBeNull();
    expect(localStorage.getItem(GITHUB_CONFIG)).toBeNull();
    expect(localStorage.getItem('health_roadmap_backend')).toBe('dropbox');
    expect(reload).not.toHaveBeenCalled();
  });

  it('control: a page running on this browser while Dropbox was unreachable still switches', async () => {
    // The session fell back to the device at load (US-09 AC13); the picker
    // still names Dropbox, which answers now.
    const { LocalStorageAdapter } = await import('../src/storage');
    await data.initRoadmapStore(new LocalStorageAdapter(), true);
    const view = render(<BackendPickerModal current="dropbox" unreachable onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    await connectGitHub(view, GOOD_TOKEN);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(document.querySelector('.hr-sync-error')).toBeNull();
    expect(weightsIn(githubBody())).toEqual({ '2026-01-01': 80 });
  });

  it('control: the first try copies down what the page saved before it', async () => {
    const view = render(<BackendPickerModal current="dropbox" onClose={() => undefined} />);
    fireEvent.click(view.getByRole('button', { name: /^GitHub/ }));
    await connectGitHub(view, GOOD_TOKEN);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(weightsIn(githubBody())).toEqual({ '2026-01-01': 80 });
  });
});
