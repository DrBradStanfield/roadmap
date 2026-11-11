// @vitest-environment jsdom
/**
 * US-16 AC2a, US-67 AC5: a chat reply to a question asked before an erase
 * applies none of its edits, and says so. The page marks the erase it shows
 * when the question is sent; the reply's edits apply only if that erase is
 * still the record's and still on screen. Otherwise nothing is written, no
 * matrix draft or profile banner is made, and the chat shows "Not saved: your
 * record changed since you asked." (as the iPhone does). Before, an erase
 * already shown when the reply landed let the reply's medication be saved into
 * the erased record, and an erase still writing dropped the edits silently.
 *
 * The whole widget renders over a real RoadmapStore and the real chat panel
 * (ChatEmbed, useChatState); only the chat's network call is a stand-in, held
 * until the test releases the reply.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act, type RenderResult } from '@testing-library/react';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { parseProposedEdit, type ProposedEdit } from '@roadmap/health-core/chat-edits';
import { RECORD_CHANGED_SINCE_ASKED } from '@roadmap/health-core/erase';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements, saveMedication } from '../lib/roadmap-data';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';
import type { SendMessageResult } from '../lib/chat-api';

/** The chat's one request: held until the test answers it. */
const chatCall = vi.hoisted(() => ({
  sent: 0,
  answer: null as null | ((r: { result: SendMessageResult; error: null }) => void),
}));
vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  listConversations: async () => null,
  loadConversation: async () => [],
  deleteConversation: async () => true,
  sendMessage: () => {
    chatCall.sent += 1;
    return new Promise((resolve) => { chatCall.answer = resolve; });
  },
}));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test',
}));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: (_el: Element, onChange: (v: boolean) => void) => { onChange(true); return () => {}; } }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

import { HealthTool } from './HealthTool';
import { openAboutYou } from '../testing/health-tool-harness';
import { deleteButton } from '../testing/settings';

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** This tab's cloud. `hold` stops its erase at the cloud write (the store
 *  already holds the erased copy) until released. */
class HeldCloud extends MemoryAdapter {
  private gate: Promise<void> | null = null;
  private entered: () => void = () => {};
  hold() {
    let release!: () => void;
    this.gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { this.entered = r; });
    return { reached, release };
  }
  override async write(name: string, body: object, version: string | null, signal?: AbortSignal) {
    if (this.gate && name === ROADMAP_FILE_NAME && ((body as RoadmapFile).meta?.eraseEpoch ?? 0) > 0) {
      this.entered();
      await this.gate;
    }
    return super.write(name, body, version, signal);
  }
}

/** A synthetic returning user on rosuvastatin, with the chat column open. */
async function userOnStatin(adapter: HeldCloud): Promise<RenderResult> {
  await initRoadmapStore(adapter);
  await saveChangedMeasurements({ birthYear: 1974, birthMonth: 1, sex: 'male', heightCm: 180 }, {});
  await addMeasurement('weight', 82, '2026-09-01');
  await saveMedication('statin', 'rosuvastatin', 10, 'mg');
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.health-tool-chat textarea')).toBeTruthy());
  await wait(600);
  openAboutYou(view.container);
  return view;
}

/** The user asks a question in the real chat panel; the reply is held. */
async function ask(view: RenderResult) {
  const before = chatCall.sent;
  const box = view.container.querySelector('.health-tool-chat textarea')!;
  fireEvent.change(box, { target: { value: 'I switched to atorvastatin 20 mg, my LDL was 3.2, and I am female' } });
  fireEvent.click(view.container.querySelector('.health-tool-chat [aria-label="Send"]')!);
  await waitFor(() => expect(chatCall.sent).toBe(before + 1));
}

/** The reply lands, with a medication, a blood-test value and a profile edit. */
async function replyLands() {
  const proposedEdits: ProposedEdit[] = [
    { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
    { kind: 'field', field: 'ldlC', displayValue: 3.2, unitSystem: 'si', date: null },
    parseProposedEdit('propose_profile_edit', { sex: 'female' })!,
  ];
  await act(async () => {
    chatCall.answer!({ result: { conversationId: 'conv-1', messageId: 'msg-1', content: 'Done, I have updated your statin.', proposedEdits }, error: null });
  });
  await wait(1500);
}

const cloudMedications = async (cloud: MemoryCloud) => {
  await act(async () => { await flushRoadmapStore(); });
  return JSON.stringify(((await new MemoryAdapter(cloud).read(ROADMAP_FILE_NAME)).body as RoadmapFile).medications);
};
const bodyText = () => document.body.textContent ?? '';
const profileBanner = () => document.body.querySelector('.chat-profile-proposal');
const undoButton = () => Array.from(document.body.querySelectorAll('.chat-banners button')).find((b) => b.textContent === 'Undo');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(() => () => {});
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  Element.prototype.scrollIntoView ??= () => {};
  chatCall.sent = 0;
  chatCall.answer = null;
});
afterEach(async () => {
  cleanup();
  await flushRoadmapStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('US-16 AC2a: a chat reply asked before an erase applies none of its edits, and says so', () => {
  it('erase shown between the question and the reply: nothing is saved, drafted or offered, and the words say so', async () => {
    const cloud = new MemoryCloud();
    const view = await userOnStatin(new HeldCloud(cloud));
    await ask(view);
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => deleteButton()));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await wait(1500);
    await replyLands();
    expect(await cloudMedications(cloud)).not.toContain('atorvastatin');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY) ?? '').not.toContain('3.2');
    expect(profileBanner()).toBeNull();
    expect(bodyText()).not.toContain('Medication updated from chat.');
    expect(bodyText()).toContain(RECORD_CHANGED_SINCE_ASKED);
  });

  it('erase still writing when the reply lands: nothing is applied, and the words say so (no silent drop)', async () => {
    const cloud = new MemoryCloud();
    const adapter = new HeldCloud(cloud);
    const view = await userOnStatin(adapter);
    await ask(view);
    const erase = adapter.hold();
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => deleteButton()));
    await erase.reached;
    await replyLands();
    expect(bodyText()).toContain(RECORD_CHANGED_SINCE_ASKED);
    expect(profileBanner()).toBeNull();
    erase.release();
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await wait(1500);
    expect(await cloudMedications(cloud)).not.toContain('atorvastatin');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY) ?? '').not.toContain('3.2');
    expect(profileBanner()).toBeNull();
    expect(bodyText()).not.toContain('Medication updated from chat.');
    // The words outlast the erase they report.
    expect(bodyText()).toContain(RECORD_CHANGED_SINCE_ASKED);
  });

  it('the notice goes at the next question', async () => {
    const view = await userOnStatin(new HeldCloud(new MemoryCloud()));
    await ask(view);
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => deleteButton()));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await wait(1500);
    await replyLands();
    expect(bodyText()).toContain(RECORD_CHANGED_SINCE_ASKED);
    await ask(view);
    expect(bodyText()).not.toContain(RECORD_CHANGED_SINCE_ASKED);
  });

  it('a refused reply takes an earlier reply\'s Undo with it: "Not saved" and Undo never show together', async () => {
    const cloud = new MemoryCloud();
    const adapter = new HeldCloud(cloud);
    const view = await userOnStatin(adapter);
    await ask(view);
    await replyLands();
    expect(bodyText()).toContain('Medication updated from chat.');
    expect(undoButton()).toBeTruthy();
    await ask(view);
    const erase = adapter.hold();
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => deleteButton()));
    await erase.reached;
    await replyLands();
    const shown = { notice: bodyText().includes(RECORD_CHANGED_SINCE_ASKED), undo: !!undoButton(), medLine: bodyText().includes('Medication updated from chat.') };
    erase.release();
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await wait(1500);
    expect(shown).toEqual({ notice: true, undo: false, medLine: false });
  });

  it('control: with no erase, the reply\'s edits apply as before', async () => {
    const cloud = new MemoryCloud();
    const view = await userOnStatin(new HeldCloud(cloud));
    await ask(view);
    await replyLands();
    expect(await cloudMedications(cloud)).toContain('atorvastatin');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY) ?? '').toContain('3.2');
    expect(profileBanner()).not.toBeNull();
    expect(bodyText()).toContain('Medication updated from chat.');
    expect(bodyText()).not.toContain(RECORD_CHANGED_SINCE_ASKED);
  });
});
