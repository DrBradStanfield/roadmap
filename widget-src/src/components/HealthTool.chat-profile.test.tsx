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
import { parseProposedEdit, ROADMAP_FILE_NAME, migrateFile, type ProposedEdit, type RoadmapFile } from '@roadmap/health-core';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, deleteUserData, flushRoadmapStore, initRoadmapStore, loadLatestMeasurements, saveChangedMeasurements, setAfterSnapshotReturn, setBeforeSnapshotIdentity } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { MIRROR_CHANGED_EVENT, MIRROR_KEY } from '../lib/storage';

const chat = vi.hoisted(() => ({
  proposeEdit: null as null | ((edits: ProposedEdit[]) => void),
  context: null as null | (() => unknown),
}));
const reload = vi.hoisted(() => ({
  complete: null as null | (() => Promise<void>),
  history: null as unknown,
}));
vi.mock('../lib/roadmap-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/roadmap-data')>();
  return { ...actual };
});

/** Hold inside the synchronous snapshot, before it returns the captured store
 *  token and erase identity. The hold is not wrapped in act: React's act
 *  flushes a pending promise before the test can erase. */
async function pauseReload() {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  setBeforeSnapshotIdentity(async () => {
    entered();
    await held;
  });
  const pending = reload.complete!();
  await waiting;
  return async () => {
    release();
    await act(async () => { await pending; });
  };
}

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
async function guestWithoutProfile(saved: { sex?: 'male' | 'female'; heightCm?: number } = {}): Promise<RenderResult> {
  await initRoadmapStore(new LocalStorageAdapter());
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
  setBeforeSnapshotIdentity(null);
  setAfterSnapshotReturn(null);
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

// US-16 AC2 / US-34: a refresh is not an erase.
it('keeps an empty guest proposal through unchanged refresh until Save', async () => {
  await initRoadmapStore(new LocalStorageAdapter());
  render(<HealthTool />);
  await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
  await wait(600);
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


// Real adapter writes and public store refresh: no invented getFile API.
for (const sameEpoch of [false, true]) {
  it(`clears a pending proposal for a ${sameEpoch ? 'same-epoch later' : 'higher-epoch'} erase with concurrent new rows`, async () => {
    const created = vi.spyOn(RoadmapStore, 'create');
    await initRoadmapStore(new LocalStorageAdapter());
    const current = await created.mock.results[0].value;
    if (sameEpoch) await deleteUserData();
    render(<HealthTool />);
    await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
    await wait(600);
    chatProposes({ sex: 'female', height: { value: 165, unit: 'cm' } });
    const adapter = new LocalStorageAdapter();
    const prior = await recordOnDisk();
    const remote = await RoadmapStore.create(adapter);
    await remote.deleteUserData();
    await remote.addMeasurement('weight', 82, '2026-09-01');
    await remote.flush();
    if (sameEpoch) {
      const read = await adapter.read(ROADMAP_FILE_NAME);
      const body = read.body as RoadmapFile;
      body.meta.eraseEpoch = prior.meta.eraseEpoch;
      await adapter.write(ROADMAP_FILE_NAME, body, read.version);
    }
    await act(async () => { await current.refreshFromRemote(); });
    // The UI relay runs asynchronously after the store announces the change.
    await wait(600);
    expect((await loadLatestMeasurements())?.previousMeasurements).toHaveLength(1);
    expect(banner()).toBeNull();
  });
}

it('clears a proposal on a store switch, even when both records are empty at the same erase identity', async () => {
  await initRoadmapStore(new LocalStorageAdapter());
  render(<HealthTool />);
  await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
  await wait(600);
  chatProposes({ sex: 'female' });
  await act(async () => { await initRoadmapStore(new LocalStorageAdapter()); });
  act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
  await wait(600);
  expect(banner()).toBeNull();
});

it('keeps medication Undo through an unchanged refresh and restores the prior medication', async () => {
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


it('clears an empty guest proposal when a real remote erase is re-read', async () => {
  const created = vi.spyOn(RoadmapStore, 'create');
  await initRoadmapStore(new LocalStorageAdapter());
  const current = await created.mock.results[0].value;
  render(<HealthTool />);
  await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
  await wait(600);
  chatProposes({ sex: 'female' });
  const remote = await RoadmapStore.create(new LocalStorageAdapter());
  await remote.deleteUserData();
  await act(async () => { await current.refreshFromRemote(); });
  await wait(600);
  expect(banner()).toBeNull();
});


async function seedLists(store: RoadmapStore) {
  store.bulkSaveLabValues([{ metricName: 'Ferritin', value: 75, unit: 'µg/L', recordedAt: '2026-09-01' }]);
  await store.saveMedication('statin', 'atorvastatin', 20, 'mg');
  await store.bulkSaveDocuments([{
    documentType: 'lab_report', title: 'Synthetic prior report', documentDate: '2026-09-01',
    contentMd: 'Synthetic fixture', metadata: {}, sourceFileName: 'synthetic-prior.pdf',
  }]);
}

it('US-09 / US-34: a pre-erase reload cannot restore its snapshot or clear a fresh proposal', async () => {
  const created = vi.spyOn(RoadmapStore, 'create');
  const view = await guestWithoutProfile({ sex: 'male', heightCm: 175 });
  await act(async () => { await seedLists(await created.mock.results[0].value); await reload.complete!(); });
  expect(JSON.stringify(reload.history)).toContain('Synthetic prior report');
  const release = await pauseReload();
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', () => {});
  fireEvent.click(await waitFor(() => view.getByText('Delete All My Data')));
  await waitFor(() => expect(view.container.querySelector<HTMLInputElement>('#heightCm')?.value ?? '').toBe(''));
  await wait(1500);
  expect(localStorage.getItem('health_roadmap_data')).toBeNull();
  chatProposes({ sex: 'female' });
  expect(banner()).not.toBeNull();
  await release();
  expect(banner()).not.toBeNull();
  expect(reload.history).toEqual({ measurements: [], labValues: [], documents: [] });
  expect(JSON.stringify(chat.context!())).not.toContain('atorvastatin');
  expect(view.container.querySelector<HTMLInputElement>('#heightCm')?.value ?? '').toBe('');
  expect(JSON.parse(localStorage.getItem('health_roadmap_data') ?? '{}').inputs?.heightCm).toBeUndefined();
  act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
  await wait(600);
  expect(banner()).not.toBeNull();
});

for (const change of ['erase', 'replace'] as const) {
  for (const newerFirst of [false, true]) {
  it(`US-34: discards a paused snapshot after ${change}, ${newerFirst ? 'after' : 'before'} a newer reload`, async () => {
    const created = vi.spyOn(RoadmapStore, 'create');
    const view = await guestWithoutProfile({ sex: 'male', heightCm: 175 });
    const current = await created.mock.results[0].value;
    await act(async () => { await seedLists(current); await reload.complete!(); });
    chatProposes({ sex: 'female' });
    const release = await pauseReload();
    await act(async () => {
      if (change === 'erase') await deleteUserData();
      else await initRoadmapStore(new LocalStorageAdapter());
      await saveChangedMeasurements({ sex: 'female', heightCm: 181 }, {});
      await addMeasurement('weight', 84, '2026-09-02');
    });
    // The obsolete completion must publish nothing, not label old values with
    // the new store identity. Detect even transient mirror writes.
    if (newerFirst) {
      await act(async () => { await reload.complete!(); });
      expect(banner()).toBeNull();
      chatProposes({ sex: 'male' });
    }
    const mirrored = vi.fn();
    window.addEventListener('hr:inputs-changed', mirrored);
    try {
      await release();
      expect(mirrored).not.toHaveBeenCalled();
      if (!newerFirst) await act(async () => { await reload.complete!(); });
      expect(banner() === null).toBe(!newerFirst);
      expect(view.container.querySelector<HTMLInputElement>('#heightCm')?.value).toBe('181');
      const mirror = JSON.parse(localStorage.getItem('health_roadmap_data')!);
      expect(mirror.inputs.heightCm).toBe(181);
      expect(mirror.previousMeasurements.find((r: { metricType: string }) => r.metricType === 'weight').value).toBe(84);
      if (change === 'erase') {
        expect(mirror.medications).toEqual([]);
        expect(reload.history).toMatchObject({ documents: [] });
        expect(JSON.stringify(chat.context!())).not.toContain('atorvastatin');
      }
    } finally {
      window.removeEventListener('hr:inputs-changed', mirrored);
    }
  });
  }
}

it('US-34: a snapshot paused before it returns publishes nothing if the same store restores that erase identity', async () => {
  vi.setSystemTime(new Date('2026-10-20T18:45:00.000Z'));
  const created = vi.spyOn(RoadmapStore, 'create');
  const view = await guestWithoutProfile({ sex: 'male', heightCm: 175 });
  const current = await created.mock.results[0].value as RoadmapStore;
  await act(async () => { await seedLists(current); await reload.complete!(); });
  await act(async () => { await current.deleteUserData(); });
  const identityBefore = current.eraseIdentity;
  const [, epoch, erasedAt] = JSON.parse(identityBefore) as [number, number, string];
  await act(async () => {
    await saveChangedMeasurements({ sex: 'male', heightCm: 175 }, {});
    await seedLists(current);
    await addMeasurement('weight', 90, '2026-09-03');
    await current.flush();
    await reload.complete!();
  });
  chatProposes({ sex: 'female' });
  const release = await pauseReload();
  const heightBefore = view.container.querySelector<HTMLInputElement>('#heightCm')?.value;
  await act(async () => {
    await current.deleteUserData();
    expect(current.eraseIdentity).not.toBe(identityBefore);
    const restored = migrateFile({
      profile: { sex: 'male', heightCm: 190 },
      measurements: [{
        id: 'restored-weight', metricType: 'weight', value: 82, recordedAt: '2026-09-01',
        status: 'active', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lamport: 1,
      }],
    }, { deviceId: 'restore-probe', now: '2026-10-20T18:45:00.000Z' });
    restored.meta.eraseEpoch = epoch;
    restored.meta.erasedAt = erasedAt;
    (current as unknown as { file: RoadmapFile }).file = restored;
    const restoredIdentity = JSON.parse(current.eraseIdentity) as [number, number, string];
    expect(restoredIdentity[0]).toBeGreaterThan(JSON.parse(identityBefore)[0] as number);
    expect(restoredIdentity[1]).toBe(epoch);
    expect(restoredIdentity[2]).toBe(erasedAt);
    expect(current.loadLatestMeasurements().previousMeasurements.some(row => row.value === 82)).toBe(true);
  });
  const historyAfterErase = reload.history;
  const contextAfterErase = chat.context!();
  const mirrorAfterErase = localStorage.getItem('health_roadmap_data');
  const mirrored = vi.fn();
  window.addEventListener('hr:inputs-changed', mirrored);
  try {
    await release();
    expect(mirrored).not.toHaveBeenCalled();
    expect(view.container.querySelector<HTMLInputElement>('#heightCm')?.value).toBe(heightBefore);
    expect(localStorage.getItem('health_roadmap_data')).toBe(mirrorAfterErase);
    expect(reload.history).toEqual(historyAfterErase);
    expect(chat.context!()).toEqual(contextAfterErase);
    expect(banner()).not.toBeNull();
    expect(JSON.stringify(reload.history)).not.toContain('atorvastatin');
    expect(JSON.stringify(chat.context!())).not.toContain('"value":82');
    expect(JSON.stringify(reload.history)).not.toContain('Ferritin');
    expect(JSON.stringify(chat.context!())).not.toContain('atorvastatin');
    expect(view.container.textContent).not.toContain('190');
  } finally {
    window.removeEventListener('hr:inputs-changed', mirrored);
  }
});
/** Hold on the caller's await immediately after loadRecordSnapshot resolves.
 *  Not wrapped in act: act would flush the pending reload before the erase. */
async function pauseAfterSnapshotReturned() {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  setAfterSnapshotReturn(async () => {
    entered();
    await held;
  });
  const pending = reload.complete!();
  await waiting;
  return async () => {
    release();
    await act(async () => { await pending; });
  };
}

for (const change of ['erase', 'replace'] as const) {
  it(`US-34: a snapshot that already returned publishes nothing if ${change} begins before the next await`, async () => {
    const created = vi.spyOn(RoadmapStore, 'create');
    const view = await guestWithoutProfile({ sex: 'male', heightCm: 175 });
    const current = await created.mock.results[0].value;
    await act(async () => { await seedLists(current); await reload.complete!(); });
    chatProposes({ sex: 'female' });
    const release = await pauseAfterSnapshotReturned();
    await act(async () => {
      if (change === 'erase') await deleteUserData();
      else await initRoadmapStore(new LocalStorageAdapter());
      await saveChangedMeasurements({ sex: 'female', heightCm: 181 }, {});
      await addMeasurement('weight', 84, '2026-09-02');
    });
    const heightAfterBoundary = view.container.querySelector<HTMLInputElement>('#heightCm')?.value;
    const mirrorAfterBoundary = localStorage.getItem('health_roadmap_data');
    const historyAfterBoundary = reload.history;
    const contextAfterBoundary = chat.context!();
    const mirrored = vi.fn();
    window.addEventListener('hr:inputs-changed', mirrored);
    try {
      await release();
      expect(mirrored).not.toHaveBeenCalled();
      expect(view.container.querySelector<HTMLInputElement>('#heightCm')?.value).toBe(heightAfterBoundary);
      expect(localStorage.getItem('health_roadmap_data')).toBe(mirrorAfterBoundary);
      expect(reload.history).toEqual(historyAfterBoundary);
      expect(chat.context!()).toEqual(contextAfterBoundary);
      expect(banner()).not.toBeNull();
      expect(JSON.stringify(reload.history)).not.toContain('"value":84');
      expect(JSON.stringify(chat.context!())).not.toContain('"value":84');
      if (change === 'erase') {
        expect(localStorage.getItem('health_roadmap_data')).toBeNull();
      }
    } finally {
      window.removeEventListener('hr:inputs-changed', mirrored);
    }
  });
}

it('US-34: two overlapping reloads of the same identity publish only the newest snapshot', async () => {
  const created = vi.spyOn(RoadmapStore, 'create');
  const view = await guestWithoutProfile({ sex: 'male', heightCm: 175 });
  const current = await created.mock.results[0].value;
  await act(async () => { await seedLists(current); await reload.complete!(); });
  chatProposes({ sex: 'female' });
  const release = await pauseReload();
  await act(async () => {
    await saveChangedMeasurements({ heightCm: 181 }, { heightCm: 175 });
    await current.saveMedication('statin', 'rosuvastatin', 10, 'mg');
    await current.bulkSaveDocuments([{
      documentType: 'lab_report', title: 'Synthetic newest report', documentDate: '2026-09-02',
      contentMd: 'Synthetic fixture', metadata: {}, sourceFileName: 'synthetic-newest.pdf',
    }]);
    await addMeasurement('weight', 84, '2026-09-02');
    await reload.complete!();
  });
  const mirror = localStorage.getItem('health_roadmap_data');
  const history = reload.history;
  const context = chat.context!();
  await release();
  expect(view.container.querySelector<HTMLInputElement>('#heightCm')?.value).toBe('181');
  expect(localStorage.getItem('health_roadmap_data')).toBe(mirror);
  expect(reload.history).toEqual(history);
  expect(JSON.stringify(reload.history)).toContain('Synthetic newest report');
  expect(chat.context!()).toEqual(context);
  expect(JSON.stringify(context)).toContain('rosuvastatin');
  expect(banner()).not.toBeNull();
});

it('keeps a new proposal after local erase through an unchanged refresh', async () => {
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
