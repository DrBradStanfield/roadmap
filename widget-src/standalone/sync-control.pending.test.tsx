// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { SyncControl } from './sync-control';
import { PENDING_MIRROR_KEY } from '../src/storage/roadmap-store';
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./backend-picker', () => ({ BackendPickerModal: () => null }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const stamp = '2026-01-01T00:00:00.000Z';
function siblingChange(key: string | null, newValue: string | null) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
}
describe('US-09 AC4b: sync status follows the shared marker across tabs', () => {
  it.each(['remove', 'clear'] as const)('clears the notice after another tab performs %s', async (operation) => {
    localStorage.setItem(PENDING_MIRROR_KEY, stamp);
    const view = render(<SyncControl backend="dropbox" />);
    expect(view.container.textContent).toContain('still waiting to sync');
    await act(async () => {
      if (operation === 'clear') localStorage.clear();
      else localStorage.removeItem(PENDING_MIRROR_KEY);
      siblingChange(operation === 'clear' ? null : PENDING_MIRROR_KEY, null);
    });
    expect(view.container.textContent).not.toContain('still waiting to sync');
  });
  it('shows the notice when another tab marks data pending', async () => {
    const view = render(<SyncControl backend="dropbox" />);
    expect(view.container.textContent).not.toContain('still waiting to sync');
    await act(async () => {
      localStorage.setItem(PENDING_MIRROR_KEY, stamp);
      siblingChange(PENDING_MIRROR_KEY, stamp);
    });
    expect(view.container.textContent).toContain('still waiting to sync');
  });
  it('ignores unrelated keys and removes the storage listener on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(<SyncControl backend="dropbox" />);
    await act(async () => {
      localStorage.setItem(PENDING_MIRROR_KEY, stamp);
      siblingChange('unrelated', 'value');
    });
    expect(view.container.textContent).not.toContain('still waiting to sync');
    const handler = add.mock.calls.find(([event]) => event === 'storage')?.[1];
    expect(handler).toBeDefined();
    view.unmount();
    expect(remove.mock.calls.some(([event, listener]) => event === 'storage' && listener === handler)).toBe(true);
  });
});
