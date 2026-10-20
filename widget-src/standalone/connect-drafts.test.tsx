// @vitest-environment jsdom
/** Shared-device log-off: real teardown + real matrix restoration, dummy data only.
 * The reload is inert; unmount/remount models the next page's empty form without
 * reconnecting the previous cloud. No provider, credential or network is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createEmptyFile, ROADMAP_FILE_NAME } from '@roadmap/health-core';
let LocalStorageAdapter: typeof import('../src/storage').LocalStorageAdapter;
import { BloodTestTimeline } from '../src/components/BloodTestTimeline';
import { StartingInfoVitals } from '../src/components/StartingInfoVitals';
import {
  BT_TIMELINE_DRAFT_KEY, VITALS_DRAFT_KEY, LPA_CHECK_KEPT_KEY, DOC_KEY_PREFIX,
  MIRROR_KEY, DRAFTS_CLEARED_EVENT,
} from '../src/lib/storage';
import { BACKEND_KEY, type Backend } from './connect';
let logOff: typeof import('./connect').logOff;
let resolveRemembered: typeof import('./connect').resolveRemembered;

const cloud = vi.hoisted(() => ({
  disconnect: vi.fn(async () => {}),
  read: vi.fn(), write: vi.fn(), delete: vi.fn(), remove: vi.fn(),
}));
// Only replace the cloud transport. Keep LocalStorageAdapter and logOff real.
vi.mock('../src/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage')>();
  class InertCloud {
    disconnect = cloud.disconnect;
    read = cloud.read;
    write = cloud.write;
    delete = cloud.delete;
    remove = cloud.remove;
  }
  return { ...actual, DropboxAdapter: InertCloud, GoogleDriveAdapter: InertCloud,
    GitHubAdapter: InertCloud, WebDavAdapter: InertCloud };
});
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const providers: Exclude<Backend, 'local'>[] = ['dropbox', 'google-drive', 'github', 'self-host'];
const retained = {
  health_roadmap_device_id: 'synthetic-device',
  health_roadmap_unit_system: 'si',
  some_other_app_key: 'keep-unrelated',
  health_roadmap_unrelated_preference: 'keep-preference',
};
const draft = (key: 'ldl' | 'weight', value: string, refused = false) => JSON.stringify({
  draft: { values: { [key]: value } },
  backfills: { '2026-01-01': { [key]: value } },
  meta: refused ? { [`new|${key}`]: { refused: 'invalid', typedOn: 'earlier-page' } } : {},
});
const noop = () => {};
const save = vi.fn(async () => new Map());

function matrices() {
  return render(<>
    <BloodTestTimeline bloodTestHistory={[]} unitSystem="si" unitOverrides={{}}
      onToggleFieldUnit={noop} onSaveBatch={save} onDraftValue={noop}
      isSaving={false} grading={null} hasApiResponse={true}/>
    <StartingInfoVitals vitalsHistory={[]} unitSystem="si" unitOverrides={{}}
      onToggleFieldUnit={noop} onSave={save} onDraftValue={noop} formStage={3}
      plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }}/>
  </>);
}
function input(container: HTMLElement, label: string): HTMLInputElement {
  const row = Array.from(container.querySelectorAll('.bt-row'))
    .find(r => r.querySelector('.bt-name-label')?.textContent === label);
  const field = row?.querySelector<HTMLInputElement>('.bt-cell-draft input');
  expect(field, `${label} draft input exists`).toBeTruthy();
  return field!;
}

beforeEach(async () => {
  // Each case represents a new page; a completed log-off never reopens its
  // page-lifetime write barrier merely because the test clears localStorage.
  vi.resetModules();
  ({ LocalStorageAdapter } = await import('../src/storage'));
  ({ logOff, resolveRemembered } = await import('./connect'));
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal('location', { reload: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in synthetic log-off test'); }));
  for (const [key, value] of Object.entries(retained)) localStorage.setItem(key, value);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function seed(backend: Backend) {
  const file = createEmptyFile({ deviceId: 'synthetic-device', now: '2026-01-01T00:00:00.000Z' });
  const device = new LocalStorageAdapter();
  await device.write(ROADMAP_FILE_NAME, file, null);
  await device.write('chat-history.json', { messages: [] }, null);
  localStorage.setItem(DOC_KEY_PREFIX + 'synthetic-scan', 'data:text/plain,synthetic');
  localStorage.setItem(MIRROR_KEY, JSON.stringify({ inputs: { heightCm: 178 } }));
  localStorage.setItem('health_roadmap_authenticated', '1');
  localStorage.setItem(BACKEND_KEY, backend);
  localStorage.setItem(BT_TIMELINE_DRAFT_KEY, draft('ldl', '2.7'));
  localStorage.setItem(VITALS_DRAFT_KEY, draft('weight', '84'));
  localStorage.setItem(LPA_CHECK_KEPT_KEY, JSON.stringify(['synthetic-lpa-row']));
  return device;
}

// Existing log-off contract (connect.test.ts): clear the device, not the cloud.
describe('shared-device cloud log-off clears off-file health data', () => {
  it.each(providers)('%s log-off removes both draft keys before reload without touching cloud data or preferences', async backend => {
    const device = await seed(backend);
    // An independent in-memory remote file, available only through transport spies.
    const remote = createEmptyFile({ deviceId: 'synthetic-cloud', now: '2026-01-01T00:00:00.000Z' });
    const original = JSON.stringify(remote);
    cloud.read.mockResolvedValue({ body: remote, version: 'synthetic-revision' });
    cloud.write.mockImplementation(async (_name, body) => Object.assign(remote, body));
    cloud.delete.mockImplementation(async () => { remote.meta.eraseEpoch = 1; });
    const cleared = vi.fn();
    window.addEventListener(DRAFTS_CLEARED_EVENT, cleared);
    // Assert at the navigation boundary, not only after logOff resolves.
    vi.mocked(location.reload).mockImplementation(() => {
      expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBeNull();
      expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    });
    try { await logOff(backend); }
    finally { window.removeEventListener(DRAFTS_CLEARED_EVENT, cleared); }
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBeNull();
    expect(await device.read(ROADMAP_FILE_NAME)).toEqual({ body: null, version: null });
    expect(await device.read('chat-history.json')).toEqual({ body: null, version: null });
    for (const key of [DOC_KEY_PREFIX + 'synthetic-scan', MIRROR_KEY, 'health_roadmap_authenticated', BACKEND_KEY]) {
      expect(localStorage.getItem(key), key).toBeNull();
    }
    for (const [key, value] of Object.entries(retained)) expect(localStorage.getItem(key), key).toBe(value);
    expect(cloud.disconnect).toHaveBeenCalledTimes(1);
    for (const operation of [cloud.read, cloud.write, cloud.delete, cloud.remove, fetch]) expect(operation).not.toHaveBeenCalled();
    expect(JSON.stringify(remote)).toBe(original);
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('the next local form cannot restore the previous user\'s drafts (refused=%s)', async refused => {
    await seed('dropbox');
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, draft('ldl', '2.7', refused));
    localStorage.setItem(VITALS_DRAFT_KEY, draft('weight', '84', refused));
    // Positive control: both real matrices actually consume these stored fixtures.
    // Do not focus/type: a draft restored from an earlier load need not commit.
    const previous = matrices();
    expect(input(previous.container, 'LDL Cholesterol').value).toBe('2.7');
    expect(input(previous.container, 'Weight').value).toBe('84');
    await act(async () => { await logOff('dropbox'); });
    previous.unmount();
    const next = await resolveRemembered();
    expect(next.backend).toBe('local');
    expect(await next.adapter.read(ROADMAP_FILE_NAME)).toEqual({ body: null, version: null });
    const current = matrices();
    // These assertions expose the retained-value path, not just key deletion.
    expect(input(current.container, 'LDL Cholesterol').value).toBe('');
    expect(input(current.container, 'Weight').value).toBe('');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still clears both drafts when the active cloud disconnect fails', async () => {
    await seed('dropbox');
    cloud.disconnect.mockRejectedValueOnce(new Error('Synthetic disconnect refusal'));
    vi.spyOn(console, 'warn').mockImplementation(noop);
    await logOff('dropbox');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(cloud.delete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
