// @vitest-environment jsdom
/**
 * US-16 AC2 (2026-10-20, Brad: "the chatbot should be asking the user to
 * input the missing values, which it can do either in the chat or in the tool
 * itself"): the chat proposes a stated sex or height, and the page writes it
 * only when the user presses Save. Not now writes nothing.
 *
 * The whole widget renders over a REAL RoadmapStore on this browser's
 * localStorage, the guest's own backend; only the network edges and the chat's
 * own UI are stubbed. Assertions read the record file through its adapter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act, type RenderResult } from '@testing-library/react';
import { parseProposedEdit, ROADMAP_FILE_NAME, CURRENT_SCHEMA_VERSION, MemoryAdapter, MemoryCloud, migrateFile, rowRootIds, type ProposedEdit, type RoadmapFile, type StorageAdapter } from '@roadmap/health-core';
import { ERASE_UNREACHABLE, REMOTE_CHANGED_EVENT, RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, bulkSaveDocuments, bulkSaveLabValues, deleteUserData, flushRoadmapStore, initRoadmapStore, loadLatestMeasurements, saveChangedMeasurements, saveMedication } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { MIRROR_CHANGED_EVENT, MIRROR_KEY } from '../lib/storage';

const chat = vi.hoisted(() => ({
  proposeEdit: null as null | ((edits: ProposedEdit[]) => void),
  context: null as null | (() => unknown),
}));
/** What the upload modal is handed: its completion (the page's re-read) and
 *  the history it shows. */
const reload = vi.hoisted(() => ({
  complete: null as null | (() => Promise<void>),
  history: null as unknown,
}));

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({
  ChatEmbed: ({ onProposeEdit, guestInputs }: { onProposeEdit: (edits: ProposedEdit[]) => void; guestInputs: () => unknown }) => {
    chat.proposeEdit = onProposeEdit;
    chat.context = guestInputs;
    return null;
  },
}));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: ({ onComplete, history }: { onComplete: () => Promise<void>; history: unknown }) => {
  reload.complete = onComplete;
  reload.history = history;
  return null;
} }));

import { HealthTool } from './HealthTool';

/** The guest's record as this browser holds it, after every pending save. */
async function recordOnDisk(): Promise<RoadmapFile> {
  await act(async () => { await flushRoadmapStore(); });
  return (await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body as RoadmapFile;
}
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const banner = () => document.body.querySelector('.chat-profile-proposal[role="status"]') as HTMLElement | null;
/** The plan computed: the empty preview ("Real suggestions appear once you fill in your details") is gone. */
const planShown = (view: RenderResult) =>
  !view.container.querySelector('.plan-empty-preview') && !!view.container.querySelector('.health-results-panel .stat-card');

/** A guest with a saved weight and no sex or height (unless given): no plan yet. */
async function guestWithoutProfile(saved: { sex?: 'male' | 'female'; heightCm?: number } = {}, adapter: StorageAdapter = new LocalStorageAdapter()): Promise<RenderResult> {
  await initRoadmapStore(adapter);
  await saveChangedMeasurements({ birthYear: 1974, birthMonth: 1, ...saved }, {});
  await addMeasurement('weight', 82, '2026-09-01');
  const view = render(<HealthTool />);
  await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
  await wait(600);
  return view;
}
/** The chat's reply: the tool block the model sent, through the real parser. */
function chatProposes(input: unknown) {
  const edit = parseProposedEdit('propose_profile_edit', input);
  expect(edit).not.toBeNull();
  act(() => chat.proposeEdit!([edit!]));
}
const pressButton = (name: string) => {
  const button = Array.from(banner()!.querySelectorAll('button')).find((b) => b.textContent === name)!;
  fireEvent.click(button);
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(() => () => {});
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  Element.prototype.scrollIntoView ??= () => {};
  chat.proposeEdit = null;
  reload.complete = null;
});
afterEach(async () => {
  cleanup();
  await flushRoadmapStore();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('US-16 AC2: the chat proposes a sex and height; the user confirms', () => {
  it('Save writes both to the profile, and the plan then computes', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    const view = await guestWithoutProfile();
    expect(planShown(view)).toBe(false);

    chatProposes({ sex: 'male', height: { value: 178, unit: 'cm' } });
    expect(banner()!.textContent).toContain('Male, 178 cm');
    await wait(1500);
    // Shown, not written: the record holds neither until the user presses Save.
    expect((await recordOnDisk()).profile).not.toHaveProperty('sex');
    expect((await recordOnDisk()).profile).not.toHaveProperty('heightCm');

    pressButton('Save');
    await wait(1500);
    const profile = (await recordOnDisk()).profile;
    expect(profile.sex).toBe('male');
    expect(profile.heightCm).toBe(178);
    expect(banner()).toBeNull();
    await waitFor(() => expect(planShown(view)).toBe(true));
    // The counter names the fields and the choice, never a value.
    expect(vi.mocked(trackProductEvent).mock.calls).toEqual(expect.arrayContaining([
      ['chat_profile_edit', { field: 'sex', choice: 'shown' }],
      ['chat_profile_edit', { field: 'heightCm', choice: 'shown' }],
      ['chat_profile_edit', { field: 'sex', choice: 'saved' }],
      ['chat_profile_edit', { field: 'heightCm', choice: 'saved' }],
    ]));
    expect(JSON.stringify(vi.mocked(trackProductEvent).mock.calls)).not.toMatch(/178|"male"/);
  });

  it('Not now writes nothing, and there is still no plan', async () => {
    const view = await guestWithoutProfile();
    chatProposes({ sex: 'female', height: { value: 165, unit: 'cm' } });
    pressButton('Not now');
    await wait(1500);
    const profile = (await recordOnDisk()).profile;
    expect(profile).not.toHaveProperty('sex');
    expect(profile).not.toHaveProperty('heightCm');
    expect(banner()).toBeNull();
    expect(planShown(view)).toBe(false);
    expect(vi.mocked(trackProductEvent)).toHaveBeenCalledWith('chat_profile_edit', { field: 'sex', choice: 'declined' });
  });

  it('shows the height in the user\'s units: feet and inches for conventional', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'conventional');
    await guestWithoutProfile();
    chatProposes({ height: { value: 70, unit: 'in' } });
    expect(banner()!.textContent).toContain(`5'10"`);
    expect(banner()!.textContent).not.toContain('Male');
    pressButton('Save');
    await wait(1500);
    expect((await recordOnDisk()).profile.heightCm).toBeCloseTo(177.8, 5);
  });

  it('names the saved value a proposal would replace, in the user\'s units', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    await guestWithoutProfile({ sex: 'female', heightCm: 175 });
    chatProposes({ sex: 'male', height: { value: 178, unit: 'cm' } });
    expect(banner()!.textContent).toBe('Save to your profile: Male (replaces Female), height 178 cm (replaces 175 cm)?Save' + 'Not now');
    pressButton('Save');
    await wait(1500);
    const profile = (await recordOnDisk()).profile;
    expect(profile.sex).toBe('male');
    expect(profile.heightCm).toBe(178);
  });

  it('shows no banner for a value already saved, and only the changed field otherwise', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    await guestWithoutProfile({ sex: 'male', heightCm: 178 });
    chatProposes({ sex: 'male', height: { value: 178, unit: 'cm' } });
    expect(banner()).toBeNull();
    expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('chat_profile_edit', expect.anything());

    chatProposes({ sex: 'male', height: { value: 180, unit: 'cm' } });
    expect(banner()!.textContent).toContain('Save to your profile: height 180 cm (replaces 178 cm)?');
    expect(banner()!.textContent).not.toContain('Male');
    expect(vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'chat_profile_edit'))
      .toEqual([['chat_profile_edit', { field: 'heightCm', choice: 'shown' }]]);
  });
});

// Review fixes, 2026-10-20 (Codex R1/R2, adversary R1/R2/R4).
describe('US-16 AC2: the proposal banner, after review', () => {
  /** One chat reply holding these tool inputs, each through the real parser. */
  const reply = (...inputs: unknown[]) => act(() => chat.proposeEdit!(inputs.map((i) => parseProposedEdit('propose_profile_edit', i)!)));

  it('a new reply replaces the pending proposal: 180 then 175, with 175 saved, shows no banner', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    await guestWithoutProfile({ sex: 'male', heightCm: 175 });
    reply({ height: { value: 180, unit: 'cm' } });
    expect(banner()!.textContent).toContain('height 180 cm (replaces 175 cm)');
    reply({ height: { value: 175, unit: 'cm' } });
    expect(banner()).toBeNull();
    // And a sex from an earlier reply does not ride into a later one.
    reply({ sex: 'female' });
    reply({ height: { value: 182, unit: 'cm' } });
    expect(banner()!.textContent).toBe('Save to your profile: height 182 cm (replaces 175 cm)?SaveNot now');
  });

  it('within one reply, a later stated field wins and an absent one does not erase', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    await guestWithoutProfile();
    reply({ sex: 'male', height: { value: 180, unit: 'cm' } }, { height: { value: 182, unit: 'cm' } });
    expect(banner()!.textContent).toBe('Save to your profile: Male, 182 cm?SaveNot now');
  });

  it('never names a field that already holds the value, even after the form changes under the banner', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    const view = await guestWithoutProfile({ sex: 'female' });
    reply({ sex: 'male', height: { value: 178, unit: 'cm' } });
    expect(banner()!.textContent).toContain('Male (replaces Female)');
    // The user picks Male in the form: their own entry outranks the proposal, which goes.
    fireEvent.click(Array.from(view.container.querySelectorAll('.sex-toggle-btn')).find((b) => b.textContent?.trim() === 'Male')!);
    expect(banner()).toBeNull();
    await wait(1500);
    expect((await recordOnDisk()).profile.sex).toBe('male');
    expect((await recordOnDisk()).profile).not.toHaveProperty('heightCm');
  });

  it('a height typed in the form clears the proposal', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    const view = await guestWithoutProfile({ sex: 'male' });
    reply({ height: { value: 178, unit: 'cm' } });
    expect(banner()).not.toBeNull();
    fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value: '181' } });
    expect(banner()).toBeNull();
  });

  it('US-16 AC2 / US-09: erasing the data clears the pending profile proposal', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    // A saved profile, so the plan shows and with it the delete link.
    const view = await guestWithoutProfile({ sex: 'female', heightCm: 175 });
    reply({ sex: 'male', height: { value: 178, unit: 'cm' } });
    expect(banner()).not.toBeNull();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', () => {});
    fireEvent.click(await waitFor(() => view.getByText('Delete All My Data')));
    await waitFor(() => expect(banner()).toBeNull());
    await wait(1500);
    const profile = (await recordOnDisk()).profile;
    expect(profile).not.toHaveProperty('sex');
    expect(profile).not.toHaveProperty('heightCm');
  });

  // Another device erases the record; this tab re-reads it (US-34). A banner
  // left standing would save the proposal into the empty record.
  it('US-16 AC2 / US-09: a remote re-read of an emptied record clears the pending proposal', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    await guestWithoutProfile({ sex: 'male' });
    reply({ height: { value: 178, unit: 'cm' } });
    // A re-read of a record that still holds values keeps the banner.
    await act(async () => { await addMeasurement('weight', 83, '2026-09-02'); });
    act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    await wait(600);
    expect(banner()).not.toBeNull();
    await act(async () => { await deleteUserData(); });
    act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('US-09 AC8: the banner portals to <body>, outside the widget root, and is masked from Clarity', async () => {
    const view = await guestWithoutProfile();
    reply({ sex: 'male' });
    expect(view.container.contains(banner())).toBe(false);
    expect(banner()!.closest('[data-clarity-mask="true"]')).not.toBeNull();
  });

  it('stacks beside the medication Undo banner instead of covering it', async () => {
    await guestWithoutProfile();
    act(() => chat.proposeEdit!([
      { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
      parseProposedEdit('propose_profile_edit', { sex: 'female' })!,
    ]));
    const column = document.body.querySelectorAll('.chat-banners');
    expect(column).toHaveLength(1);
    const banners = column[0].querySelectorAll(':scope > [role="status"]');
    expect(Array.from(banners, (b) => b.textContent)).toEqual(['Medication updated from chat.Undo✕', 'Save to your profile: Female?SaveNot now']);
    expect(column[0].getAttribute('data-clarity-mask')).toBe('true');
    // Answering one leaves the other.
    pressButton('Not now');
    expect(document.body.querySelector('.chat-banners [role="status"]')!.textContent).toBe('Medication updated from chat.Undo✕');
  });

  it('adversary R1: an edit of a kind this build does not know writes nothing', async () => {
    await guestWithoutProfile();
    const before = await recordOnDisk();
    act(() => chat.proposeEdit!([{ kind: 'goal', target: 5 } as unknown as ProposedEdit]));
    await wait(1500);
    expect(document.body.querySelector('.chat-banners')).toBeNull();
    expect((await loadLatestMeasurements())?.medications ?? []).toEqual([]);
    const after = await recordOnDisk();
    expect(after.medications).toEqual(before.medications);
    expect(after.profile).toEqual(before.profile);
  });
});

// US-16 AC2a: a refresh is not an erase. A proposal (and the medication Undo)
// stands through a re-read that brings no erase, and goes with one that does,
// whichever device made it.
describe('US-16 AC2a: a pending proposal follows the record\'s erase, not its rows', () => {
  /** This tab's own store, as initRoadmapStore made it. */
  async function thisTabsStore(): Promise<RoadmapStore> {
    const created = vi.mocked(RoadmapStore.create).mock.results;
    return created[created.length - 1].value;
  }
  /** Another device erases the record in the shared cloud, as its own
   *  deleteUserData writes it (US-09 AC23), and may save a row after. This
   *  page never makes a second store: it learns of the erase only by
   *  re-reading the cloud. */
  async function otherDeviceErases(cloud: MemoryCloud, opts: { sameEpoch?: boolean; weightAfter?: number } = {}) {
    const adapter = new MemoryAdapter(cloud);
    const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
    const now = new Date(Date.now() + 1000).toISOString();
    const ctx = { deviceId: 'other-device', now };
    const prior = migrateFile(body, ctx);
    const erased = migrateFile(null, ctx);
    const epoch = (prior.meta.eraseEpoch ?? 0) + (opts.sameEpoch ? 0 : 1);
    erased.schemaVersion = CURRENT_SCHEMA_VERSION;
    const ids = new Set([...rowRootIds(prior), ...(prior.erasedRows?.ids ?? [])]);
    erased.erasedRows = { fromEpoch: prior.erasedRows?.fromEpoch ?? epoch, ids: [...ids].sort() };
    erased.meta.eraseEpoch = epoch;
    erased.meta.erasedAt = now;
    if (opts.weightAfter !== undefined) {
      erased.measurements.push({
        id: 'post-erase-weight', metricType: 'weight', value: opts.weightAfter, recordedAt: '2026-09-02',
        createdAt: now, source: 'manual', status: 'active', correctsId: null, externalId: null,
      });
    }
    await adapter.write(ROADMAP_FILE_NAME, erased, version);
  }
  async function cloudGuest(cloud: MemoryCloud, saved?: { sex?: 'male' | 'female'; heightCm?: number }) {
    vi.spyOn(RoadmapStore, 'create');
    return saved ? guestWithoutProfile(saved, new MemoryAdapter(cloud)) : emptyGuest(new MemoryAdapter(cloud));
  }
  async function emptyGuest(adapter: StorageAdapter = new LocalStorageAdapter()) {
    await initRoadmapStore(adapter);
    const view = render(<HealthTool />);
    await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
    await wait(600);
    return view;
  }
  const refreshThisTab = async () => {
    await act(async () => { await (await thisTabsStore()).refreshFromRemote(); });
    await wait(600);
  };

  it('keeps an empty guest\'s proposal through an unchanged refresh, and Save then writes it', async () => {
    await emptyGuest();
    const before = (await recordOnDisk()).meta;
    chatProposes({ sex: 'female', height: { value: 165, unit: 'cm' } });
    act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    await wait(600);
    expect((await recordOnDisk()).meta.eraseEpoch).toBe(before.eraseEpoch);
    expect(banner()).not.toBeNull();
    expect((await recordOnDisk()).profile).not.toHaveProperty('sex');
    pressButton('Save');
    await wait(1500);
    expect((await recordOnDisk()).profile).toMatchObject({ sex: 'female', heightCm: 165 });
  });

  it('keeps medication Undo through an unchanged refresh, and Undo restores the prior answer', async () => {
    await guestWithoutProfile();
    act(() => chat.proposeEdit!([
      { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
    ]));
    await wait(1500);
    act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    await wait(600);
    const undo = Array.from(document.body.querySelectorAll('.chat-banners button')).find(b => b.textContent === 'Undo');
    expect(undo).toBeTruthy();
    fireEvent.click(undo!);
    await wait(1500);
    expect((await loadLatestMeasurements())?.medications.find(m => m.medicationKey === 'statin')?.drugName).toBe('none');
  });

  it('keeps a proposal made after this tab\'s own erase through an unchanged refresh', async () => {
    const view = await guestWithoutProfile({ sex: 'male', heightCm: 175 });
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', () => {});
    fireEvent.click(await waitFor(() => view.getByText('Delete All My Data')));
    await wait(1500);
    chatProposes({ sex: 'female' });
    expect(banner()).not.toBeNull();
    act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    await wait(600);
    expect(banner()).not.toBeNull();
  });

  it('clears an empty guest\'s proposal when another device\'s erase is re-read', async () => {
    const cloud = new MemoryCloud();
    await cloudGuest(cloud);
    chatProposes({ sex: 'female', height: { value: 165, unit: 'cm' } });
    expect(banner()).not.toBeNull();
    await otherDeviceErases(cloud);
    await refreshThisTab();
    expect(banner()).toBeNull();
    // Again, at the same epoch: an empty record erased again can differ only
    // in its erasedAt, which the merge keeps (the later one, US-09 AC20).
    chatProposes({ sex: 'female' });
    expect(banner()).not.toBeNull();
    await wait(6000); // past the re-read throttle
    await otherDeviceErases(cloud, { sameEpoch: true });
    await refreshThisTab();
    expect(banner()).toBeNull();
  });

  for (const sameEpoch of [false, true]) {
    it(`clears the proposal and Undo for another device's ${sameEpoch ? 'later erase at the same epoch' : 'erase'}, though a post-erase row remains`, async () => {
      const cloud = new MemoryCloud();
      await cloudGuest(cloud, { sex: 'male' });
      act(() => chat.proposeEdit!([
        { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
        parseProposedEdit('propose_profile_edit', { height: { value: 178, unit: 'cm' } })!,
      ]));
      await wait(1500);
      expect(document.body.querySelectorAll('.chat-banners [role="status"]')).toHaveLength(2);
      await otherDeviceErases(cloud, { sameEpoch, weightAfter: 84 });
      await refreshThisTab();
      expect((await loadLatestMeasurements())?.previousMeasurements.map(m => m.value)).toEqual([84]);
      expect(document.body.querySelector('.chat-banners')).toBeNull();
    });
  }

  it('Save refuses a proposal made before an erase this page has not yet shown', async () => {
    const cloud = new MemoryCloud();
    await cloudGuest(cloud, { sex: 'male' });
    chatProposes({ height: { value: 178, unit: 'cm' } });
    // The store takes the erase in, but the page is not told (as while the
    // relay holds a remote change behind an unsaved profile edit, US-34 AC4).
    const swallow = (e: Event) => e.stopImmediatePropagation();
    window.addEventListener(REMOTE_CHANGED_EVENT, swallow, { capture: true });
    try {
      await otherDeviceErases(cloud);
      await refreshThisTab();
    } finally {
      window.removeEventListener(REMOTE_CHANGED_EVENT, swallow, { capture: true });
    }
    expect(banner()).not.toBeNull();
    pressButton('Save');
    await wait(1500);
    expect(banner()).toBeNull();
    const stored = await new MemoryAdapter(cloud).read(ROADMAP_FILE_NAME);
    expect((stored.body as RoadmapFile).profile).not.toHaveProperty('heightCm');
    expect((await loadLatestMeasurements())?.inputs.heightCm).toBeUndefined();
  });

  it('US-09 AC23: an erase refused because the cloud cannot be read leaves the medications and screenings on screen', async () => {
    const cloud = new MemoryCloud();
    await initRoadmapStore(new MemoryAdapter(cloud));
    await saveChangedMeasurements({ birthYear: 1974, birthMonth: 1, sex: 'male', heightCm: 180 }, {});
    await addMeasurement('weight', 82, '2026-09-01');
    await saveMedication('statin', 'atorvastatin', 20, 'mg');
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
    await wait(600);
    const contextBefore = JSON.stringify(chat.context!());
    const mirrorBefore = localStorage.getItem(MIRROR_KEY);
    expect(contextBefore).toContain('atorvastatin');
    expect(mirrorBefore).toContain('atorvastatin');
    vi.spyOn(MemoryAdapter.prototype, 'read').mockRejectedValueOnce(new Error('cloud did not answer'));
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => view.getByText('Delete All My Data')));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(ERASE_UNREACHABLE));
    await wait(600);
    expect(JSON.stringify(chat.context!())).toBe(contextBefore);
    expect(localStorage.getItem(MIRROR_KEY)).toBe(mirrorBefore);
    expect(planShown(view)).toBe(true);
  });

  it('US-11: a successful erase clears the lab rows and documents the upload view holds', async () => {
    const view = await guestWithoutProfile({ sex: 'male', heightCm: 175 });
    await act(async () => {
      await bulkSaveLabValues([{ metricName: 'Ferritin', value: 75, unit: 'µg/L', recordedAt: '2026-09-01' }]);
      await bulkSaveDocuments([{
        documentType: 'lab_report', title: 'Synthetic prior report', documentDate: '2026-09-01',
        contentMd: 'Synthetic fixture', metadata: {}, sourceFileName: 'synthetic-prior.pdf',
      }]);
      await reload.complete!();
    });
    expect(JSON.stringify(reload.history)).toContain('Synthetic prior report');
    expect(JSON.stringify(reload.history)).toContain('Ferritin');
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', () => {});
    fireEvent.click(await waitFor(() => view.getByText('Delete All My Data')));
    await wait(1500);
    expect(reload.history).toEqual({ measurements: [], labValues: [], documents: [] });
  });

  // Review R1/R3 (2026-10-21): while the store holds an erase the screen does
  // not show yet, the screen's values are pre-erase. A banner made then, or a
  // form save scheduled before the erase, would write them into the erased record.
  /** This tab's cloud. `hold` stops its erase at the cloud write (the store
   *  already holds the erased copy), then lets it land or fail. */
  class HeldCloud extends MemoryAdapter {
    private gate: Promise<void> | null = null;
    private fail = false;
    private entered: () => void = () => {};
    hold(fail = false) {
      let release!: () => void;
      this.gate = new Promise<void>((r) => { release = r; });
      this.fail = fail;
      const reached = new Promise<void>((r) => { this.entered = r; });
      return { reached, release };
    }
    open() { this.gate = null; }
    override async write(name: string, body: object, version: string | null, signal?: AbortSignal) {
      if (this.gate && name === ROADMAP_FILE_NAME && ((body as RoadmapFile).meta?.eraseEpoch ?? 0) > 0) {
        this.entered();
        await this.gate;
        if (this.fail) throw new Error('cloud did not answer');
      }
      return super.write(name, body, version, signal);
    }
  }
  async function cloudGuestOnStatin(adapter: HeldCloud) {
    await initRoadmapStore(adapter);
    await saveChangedMeasurements({ birthYear: 1974, birthMonth: 1, sex: 'male', heightCm: 180 }, {});
    await addMeasurement('weight', 82, '2026-09-01');
    await saveMedication('statin', 'rosuvastatin', 10, 'mg');
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
    await wait(600);
    return view;
  }
  const cloudMedications = async (cloud: MemoryCloud) =>
    JSON.stringify(((await new MemoryAdapter(cloud).read(ROADMAP_FILE_NAME)).body as RoadmapFile).medications);
  const undoButton = () => Array.from(document.body.querySelectorAll('.chat-banners button')).find(b => b.textContent === 'Undo') as HTMLElement | undefined;
  const atorvastatin: ProposedEdit = { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' };

  it('a chat reply during this tab\'s erase makes no Undo, so no pre-erase medication is written back', async () => {
    const cloud = new MemoryCloud();
    const adapter = new HeldCloud(cloud);
    const view = await cloudGuestOnStatin(adapter);
    const erase = adapter.hold();
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => view.getByText('Delete All My Data')));
    await erase.reached;
    act(() => chat.proposeEdit!([atorvastatin, parseProposedEdit('propose_profile_edit', { sex: 'female' })!]));
    const undo = undoButton();
    const offered = { undo: !!undo, profile: !!banner() };
    if (undo) fireEvent.click(undo); // the old code offered it: rosuvastatin back
    await wait(600);
    erase.release();
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await wait(1500);
    expect(offered).toEqual({ undo: false, profile: false });
    expect(await cloudMedications(cloud)).not.toContain('rosuvastatin');
  });

  it('after an erase whose write failed, a chat reply makes no banner', async () => {
    const cloud = new MemoryCloud();
    const adapter = new HeldCloud(cloud);
    const view = await cloudGuestOnStatin(adapter);
    const erase = adapter.hold(true);
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => view.getByText('Delete All My Data')));
    await erase.reached;
    erase.release();
    await waitFor(() => expect(alert).toHaveBeenCalled());
    act(() => chat.proposeEdit!([atorvastatin, parseProposedEdit('propose_profile_edit', { sex: 'female' })!]));
    adapter.open();
    expect(undoButton()).toBeUndefined();
    expect(banner()).toBeNull();
  });

  it('a medication save scheduled before this tab\'s erase does not land in the erased record', async () => {
    const cloud = new MemoryCloud();
    const adapter = new HeldCloud(cloud);
    const view = await cloudGuestOnStatin(adapter);
    const erase = adapter.hold();
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    act(() => chat.proposeEdit!([atorvastatin])); // its save waits 300 ms
    fireEvent.click(await waitFor(() => view.getByText('Delete All My Data')));
    await erase.reached;
    await wait(600); // the save's timer fires while the erase is still writing
    erase.release();
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await wait(1500);
    const meds = await cloudMedications(cloud);
    expect(meds).not.toContain('atorvastatin');
    expect(meds).not.toContain('rosuvastatin');
  });
});

// Codex R2 + adversary R1: once the record erase landed, a failed on-device
// cleanup step must not leave the chat's copy of the record or the screen.
describe('US-11 AC3b / AC8: an erase whose device cleanup fails still clears the chat copy and the screen', () => {
  it('clears the mirror, mutes the embed, resets the form and says what is incomplete', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    const view = await guestWithoutProfile({ sex: 'male', heightCm: 180 });
    expect(planShown(view)).toBe(true);
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ inputs: { sex: 'male', heightCm: 180 } }));
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'health_roadmap_local_erase_generation') throw new Error('synthetic quota failure');
      original.call(this, key, value);
    });
    const embedNotified = vi.fn();
    window.addEventListener(MIRROR_CHANGED_EVENT, embedNotified);
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => view.getByText('Delete All My Data')));
    await waitFor(() => expect(alert).toHaveBeenCalledOnce());
    window.removeEventListener(MIRROR_CHANGED_EVENT, embedNotified);
    expect(localStorage.getItem(MIRROR_KEY) ?? '').not.toContain('180');
    expect(embedNotified).toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toContain('deleted');
    expect(alert.mock.calls[0][0]).toContain('Could not complete on-device history cleanup.');
    await wait(600);
    expect(planShown(view)).toBe(false);
  });
});
