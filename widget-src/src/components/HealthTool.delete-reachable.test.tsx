// @vitest-environment jsdom
/**
 * US-11 AC (H114): "Delete all my data" stays in Settings whenever a record
 * exists, drawn as a plan or not: after a first read that failed before it
 * showed anything, for a record with values but no complete profile, and for
 * a visitor whose only stored data is a chat conversation. A
 * truly empty new visitor does not see it. Log off stays reachable from the
 * same page with a cloud connected.
 *
 * The whole widget over a real RoadmapStore on localStorage (testing/health-tool-harness).
 * Synthetic values only.
 */
import { expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { recordOnDisk, seedGuest, settle, useHealthToolLifecycle } from '../testing/health-tool-harness';
import { openSettings } from '../testing/settings';
import { initRoadmapStore } from '../lib/roadmap-data';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { ChatHistoryStore } from '../storage/chat-history-store';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));
vi.mock('../../standalone/google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../../standalone/reminders', () => ({ remindersSupported: () => false }));
vi.mock('../../standalone/reminders-control', () => ({ RemindersControl: () => null }));
// The first read's last write, the chat mirror, throws once when asked: the read fails before
// the page shows anything (as failMirror does in HealthTool.record-read-pins.test.tsx).
const failMirror = vi.hoisted(() => ({ next: false, threw: false }));
vi.mock('../lib/storage', async original => {
  const real = await original<typeof import('../lib/storage')>();
  return {
    ...real,
    saveToLocalStorage: (...args: Parameters<typeof real.saveToLocalStorage>) => {
      if (failMirror.next) { Object.assign(failMirror, { next: false, threw: true }); throw new Error('Synthetic test: mirror failed'); }
      return real.saveToLocalStorage(...args);
    },
  };
});

import { HealthTool } from './HealthTool';
import { StorageBar, SyncControl } from '../../standalone/sync-control';

useHealthToolLifecycle();

const deleteButton = (root: HTMLElement) => within(root.querySelector<HTMLElement>('.mh-settings')!).queryByRole('button', { name: 'Delete all my data' });
const loaded = (root: HTMLElement) => waitFor(() => expect(root.querySelector('.mh-header')).not.toBeNull());

it('US-11 (H114): a first read that fails before it shows anything still offers Delete all my data', async () => {
  await initRoadmapStore(new LocalStorageAdapter());
  failMirror.next = true;
  const view = render(<HealthTool/>);
  await waitFor(() => expect(failMirror.threw).toBe(true));
  await settle(20);
  openSettings(view.container);
  expect(deleteButton(view.container)).not.toBeNull();
});

it('US-11 (H114): a record with values but no complete profile offers Delete, and pressing it erases the record', async () => {
  await seedGuest({ sex: 'female' }, [['weight', 70], ['ldl', 3.1]]); // no height: no plan (US-07 AC8)
  const view = render(<HealthTool/>);
  await loaded(view.container);
  await settle(20);
  openSettings(view.container);
  const button = deleteButton(view.container);
  expect(button).not.toBeNull();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  fireEvent.click(button!);
  await waitFor(async () => expect((await recordOnDisk()).measurements.filter(m => m.status === 'active')).toHaveLength(0));
});

it('US-11 (H114): a visitor whose only stored data is one conversation sees Delete, and using it leaves no conversation', async () => {
  const chat = await ChatHistoryStore.create(new LocalStorageAdapter());
  await chat.recordExchange({ conversationId: 'c-only', isNew: true, userText: 'Synthetic question', assistantText: 'Synthetic answer.' });
  await initRoadmapStore(new LocalStorageAdapter());
  const view = render(<HealthTool/>);
  await loaded(view.container);
  await settle(20);
  openSettings(view.container);
  const button = await waitFor(() => { const b = deleteButton(view.container); expect(b).not.toBeNull(); return b!; });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  fireEvent.click(button);
  await waitFor(async () => expect((await ChatHistoryStore.create(new LocalStorageAdapter())).listConversations()).toEqual([]));
});

it('US-11 (H114): a truly empty new visitor does not see Delete all my data', async () => {
  await initRoadmapStore(new LocalStorageAdapter());
  const view = render(<HealthTool/>);
  await loaded(view.container);
  await settle(20);
  openSettings(view.container);
  expect(view.container.querySelector('.mh-settings')).not.toBeNull();
  expect(deleteButton(view.container)).toBeNull();
});

it('US-09 (H114 pin): with a cloud connected, Log off is reachable from the same Settings that hold Delete', async () => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false; };
  await seedGuest({ sex: 'female' }, [['weight', 70], ['ldl', 3.1]]); // no height: no plan (US-07 AC8)
  const view = render(
    <HealthTool
      storageBar={<StorageBar backend="dropbox"/>}
      syncControl={({ hasData, attention }) => <SyncControl backend="dropbox" hasData={hasData} attention={attention}/>}
    />,
  );
  await loaded(view.container);
  await settle(20);
  openSettings(view.container);
  expect(deleteButton(view.container)).not.toBeNull();
  fireEvent.click(within(view.container.querySelector<HTMLElement>('.mh-settings .hr-sync-cloud')!).getByRole('button', { name: 'Dropbox' }));
  const picker = await waitFor(() => { const el = document.querySelector<HTMLElement>('dialog.hr-modal'); expect(el).not.toBeNull(); return el!; });
  expect(within(picker).getByRole('button', { name: 'Log off this device' })).toBeTruthy();
});
