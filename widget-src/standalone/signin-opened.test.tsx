// @vitest-environment jsdom
/**
 * US-62 AC1-AC3: `signin_opened` is sent when a guest opens the connect flow,
 * with the placement it was opened from: `top_bar` from the storage button
 * (US-09 AC30), `plan_panel` from the plan's storage prompt. The real
 * `trackProductEvent` runs, with its Shopify gate and per-tab throttle; only
 * fetch and the storage layer are stand-ins.
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../src/lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/storage', () => ({
  GoogleDriveAdapter: class { connectViaPopup = vi.fn(async () => {}); },
  GitHubAdapter: class {},
  WebDavAdapter: class {},
  isSyncPending: () => false,
  SYNC_PENDING_EVENT: 'hr:sync-pending',
  gisReady: () => true,
  preloadGis: () => undefined,
}));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', () => ({
  storageState: (backend: string, reconnect?: string) =>
    (reconnect ? 'reconnect' : backend === 'local' ? 'guest' : 'cloud'),
  prepareSwitch: vi.fn(),
  liftLocalInto: vi.fn(),
  adapterFor: () => null,
  finishFormConnect: vi.fn(),
  logOff: vi.fn(),
  connectRefusal: () => null,
  rememberBackend: vi.fn(),
  forgetBackend: vi.fn(),
  forgetClearedErase: vi.fn(),
  useBusyRun: () => ({ busy: false, error: null, setError: vi.fn(), run: (fn: () => Promise<void>) => fn() }),
}));

import { StorageBar, SyncControl } from './sync-control';
import { PLAN_STORAGE_CTA } from '../src/lib/storage-notice';
import type { Backend } from './connect';

let sent: Array<{ eventName: string; metadata?: unknown }> = [];
const signins = () => sent.filter((e) => e.eventName === 'signin_opened').map((e) => e.metadata);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
beforeEach(() => {
  sent = [];
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/events')) sent.push(JSON.parse(String(init?.body)));
    return new Response('{"success":true}');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The bar and the plan's SyncControl, as app.tsx mounts them. */
const mount = (backend: Backend) => render(
  <>
    <StorageBar backend={backend} />
    <SyncControl backend={backend} hasData />
  </>,
);
const bar = () => document.querySelector('button.action-btn-small') as HTMLButtonElement;
const dialog = () => document.querySelector('dialog.hr-modal');
const planCta = () => [...document.querySelectorAll('button')].find((b) => b.textContent === PLAN_STORAGE_CTA)!;
const planLink = () => document.querySelector('button.hr-storage-link') as HTMLButtonElement;

describe('US-62 AC3: signin_opened from the top bar', () => {
  it('a guest\'s Sign in sends top_bar once per tab, and opens the picker', () => {
    mount('local');
    fireEvent.click(bar());
    expect(dialog()).not.toBeNull();
    fireEvent.click(bar());
    expect(signins()).toEqual([{ placement: 'top_bar' }]);
  });

  it('a connected record\'s provider link (in the storage card: the title line is text) opens the picker but sends nothing', () => {
    mount('dropbox');
    expect(bar()).toBeNull();
    fireEvent.click(document.querySelector('.hr-sync-status-link')!);
    expect(dialog()).not.toBeNull();
    expect(signins()).toEqual([]);
  });
});

describe('US-62 AC3: signin_opened from the plan panel', () => {
  it('the guest prompt and its provider link send plan_panel once per tab, and open the picker', () => {
    mount('local');
    fireEvent.click(planCta());
    expect(dialog()).not.toBeNull();
    fireEvent.click(planLink());
    expect(signins()).toEqual([{ placement: 'plan_panel' }]);
  });

  it('top bar and plan panel each count in the same tab', () => {
    mount('local');
    fireEvent.click(planCta());
    fireEvent.click(bar());
    expect(signins()).toEqual([{ placement: 'plan_panel' }, { placement: 'top_bar' }]);
  });
});
