// @vitest-environment jsdom
/**
 * US-09 AC30 on My health (US-62 AC24): a connected record's storage button on
 * the title line opens the picker with Settings closed. The picker's one host
 * is the plan's SyncControl, which since phase 5 sits in Settings: it must stay
 * mounted when Settings is shut. Mounted as standalone/app.tsx mounts it, on
 * the real store. Synthetic values only.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';

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

const picker = () => document.querySelector('dialog.hr-modal');

it('US-09 AC30: the title line\'s Dropbox button opens the picker with Settings closed, and once with them open', async () => {
  const view = render(
    <HealthTool
      storageBar={<StorageBar backend="dropbox" />}
      syncControl={({ hasData, attention }) => <SyncControl backend="dropbox" hasData={hasData} attention={attention} />}
    />,
  );
  const header = await waitFor(() => { const el = view.container.querySelector('.mh-header'); expect(el).not.toBeNull(); return el!; });
  expect(view.container.querySelector('.mh-settings')).toBeNull(); // Settings shut
  const storageButton = [...header.querySelectorAll('button')].find(b => b.textContent?.includes('Dropbox'))!;
  expect(storageButton).toBeDefined();
  fireEvent.click(storageButton);
  await waitFor(() => expect(picker()).not.toBeNull());
  expect(document.querySelectorAll('dialog.hr-modal')).toHaveLength(1);
  // The card's own text stays out of the page until Settings open.
  expect(view.container.querySelector('.hr-sync-cloud')!.closest('[hidden]')).not.toBeNull();
  fireEvent.click(within(picker()!).getAllByRole('button').find(b => /close|cancel/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))!);
  await waitFor(() => expect(picker()).toBeNull());

  openSettings(view.container);
  const card = view.container.querySelector('.mh-settings .hr-sync-cloud')!;
  expect(card).not.toBeNull();
  fireEvent.click(storageButton);
  await waitFor(() => expect(picker()).not.toBeNull());
  expect(document.querySelectorAll('dialog.hr-modal')).toHaveLength(1);
});
