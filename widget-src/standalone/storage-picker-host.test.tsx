// @vitest-environment jsdom
/**
 * US-09 AC30 on My health (US-62 AC24): a connected record's title line says
 * "Synced to Dropbox" as text (Brad 2026-11-09); the picker opens with Settings
 * closed from every other way in, and from the storage card's provider link. The picker's one host
 * is the plan's SyncControl, which since phase 5 sits in Settings: it must stay
 * mounted when Settings is shut. Mounted as standalone/app.tsx mounts it, on
 * the real store. Synthetic values only.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', async original => ({
  ...(await original<typeof import('../src/lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../src/lib/chat-api', async original => ({
  ...(await original<typeof import('../src/lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
// The record lives in a cloud: the storage card belongs in Settings, not at the foot.
vi.mock('../src/lib/roadmap-data', async original => ({
  ...(await original<typeof import('../src/lib/roadmap-data')>()),
  getBackendKind: () => 'cloud' as const,
}));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));

import { HealthTool } from '../src/components/HealthTool';
import { StorageBar, SyncControl } from './sync-control';
import { LocalStorageAdapter } from '../src/storage/local-storage-adapter';
import { flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../src/lib/roadmap-data';
import { openSettings } from '../src/testing/settings';
import { openBackendPicker } from '../src/lib/storage-notice';

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  Element.prototype.scrollIntoView ??= () => {};
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false; };
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({ sex: 'female', heightCm: 165, birthYear: 1975, birthMonth: 5, unitSystem: 'si', weightKg: 64 }, {});
  await flushRoadmapStore();
});
afterEach(async () => {
  cleanup();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const picker = () => document.querySelector<HTMLElement>('dialog.hr-modal');

const mountDropbox = () => render(
  <HealthTool
    storageBar={<StorageBar backend="dropbox" />}
    syncControl={({ hasData, attention }) => <SyncControl backend="dropbox" hasData={hasData} attention={attention} />}
  />,
);

it('US-09 AC30: on desktop the title line says "Synced to Dropbox" as text; the picker opens with Settings closed, and once from the card in Settings', async () => {
  const view = mountDropbox();
  const header = await waitFor(() => { const el = view.container.querySelector('.mh-header'); expect(el).not.toBeNull(); return el!; });
  expect(view.container.querySelector('.mh-settings')).toBeNull(); // Settings shut
  expect(header.querySelector('.hr-storage-state')?.textContent).toBe('Synced to Dropbox');
  expect([...header.querySelectorAll('button')].map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Settings']); // not a button
  act(() => openBackendPicker()); // e.g. the upload's storage line or a notice above the widget
  await waitFor(() => expect(picker()).not.toBeNull());
  expect(document.querySelectorAll('dialog.hr-modal')).toHaveLength(1);
  // The card's own text stays out of the page until Settings open.
  expect(view.container.querySelector('.hr-sync-cloud')!.closest('[hidden]')).not.toBeNull();
  fireEvent.click(within(picker()!).getAllByRole('button').find(b => /close|cancel/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))!);
  await waitFor(() => expect(picker()).toBeNull());

  openSettings(view.container);
  const card = view.container.querySelector<HTMLElement>('.mh-settings .hr-sync-cloud')!;
  fireEvent.click(within(card).getByRole('button', { name: 'Dropbox' }));
  await waitFor(() => expect(picker()).not.toBeNull());
  expect(document.querySelectorAll('dialog.hr-modal')).toHaveLength(1);
});

// Design re-check 2026-11-06: opened by a tap, the picker drew a heavy focus ring on its ×.
// The first focus goes to its title (no ring), and Tab still reaches every control.
it('the picker opens with the focus on its title, not on its × button', async () => {
  const view = mountDropbox();
  await waitFor(() => expect(view.container.querySelector('.mh-header')).not.toBeNull());
  openSettings(view.container);
  fireEvent.click(within(view.container.querySelector<HTMLElement>('.mh-settings .hr-sync-cloud')!).getByRole('button', { name: 'Dropbox' }));
  await waitFor(() => expect(picker()).not.toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(picker()!.querySelector('h2')));
});
