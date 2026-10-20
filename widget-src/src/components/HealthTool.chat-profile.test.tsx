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
import { parseProposedEdit, ROADMAP_FILE_NAME, type ProposedEdit, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, loadLatestMeasurements, saveChangedMeasurements } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';

const chat = vi.hoisted(() => ({ proposeEdit: null as null | ((edits: ProposedEdit[]) => void) }));

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({
  ChatEmbed: ({ onProposeEdit }: { onProposeEdit: (edits: ProposedEdit[]) => void }) => {
    chat.proposeEdit = onProposeEdit;
    return null;
  },
}));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

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

  it('erasing the data clears the proposal', async () => {
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
