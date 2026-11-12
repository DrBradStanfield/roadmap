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
import { ERASE_IN_PROGRESS, RECORD_CHANGED_SINCE_ASKED } from '@roadmap/health-core/erase';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { stampFields } from '@roadmap/health-core/merge';
import { ERASE_UNREACHABLE, RoadmapStore } from '../storage/roadmap-store';
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
  listConversations: async () => ({ conversations: [{ id: 'saved-1', title: 'Saved chat', updatedAt: 'x', createdAt: 'x' }] }),
  loadConversation: async () => [{ id: 'saved-q', role: 'user', content: 'An older question', createdAt: 'x' }],
  deleteConversation: async () => true,
  sendMessage: () => {
    chatCall.sent += 1;
    return new Promise((resolve) => { chatCall.answer = resolve; });
  },
}));
/** Another tab's chat messages, as this tab's BroadcastChannel hears them. */
const sync = vi.hoisted(() => ({ hear: null as null | ((msg: unknown) => void) }));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), generateInstanceId: () => 'test',
  subscribeSync: (hear: (msg: unknown) => void) => { sync.hear = hear; return () => {}; },
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
  private readGate: Promise<void> | null = null;
  private readEntered: () => void = () => {};
  private readFails = false;
  /** Stops the next read of the record (the erase's stored read) until released; `fail`: it then finds the cloud unreachable. */
  holdRead(fail = false) {
    let release!: () => void;
    this.readGate = new Promise<void>((r) => { release = r; });
    this.readFails = fail;
    const reached = new Promise<void>((r) => { this.readEntered = r; });
    return { reached, release };
  }
  override async read(name: string, signal?: AbortSignal) {
    const gate = name === ROADMAP_FILE_NAME ? this.readGate : null;
    if (gate) {
      this.readGate = null;
      this.readEntered();
      await gate;
      if (this.readFails) throw new Error('Synthetic: cloud did not answer');
    }
    return super.read(name, signal);
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

  it('erase still reading when the reply lands: nothing is applied, and the words say the data is being deleted (lead A6)', async () => {
    const cloud = new MemoryCloud();
    const adapter = new HeldCloud(cloud);
    const view = await userOnStatin(adapter);
    await ask(view);
    const read = adapter.holdRead();
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => deleteButton()));
    await read.reached;
    await replyLands();
    expect(bodyText()).not.toContain('Medication updated from chat.');
    expect(profileBanner()).toBeNull();
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY) ?? '').not.toContain('3.2');
    expect(bodyText()).toContain(ERASE_IN_PROGRESS);
    expect(bodyText()).not.toContain(RECORD_CHANGED_SINCE_ASKED);
    read.release();
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await wait(1500);
    expect(await cloudMedications(cloud)).not.toContain('atorvastatin');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY) ?? '').not.toContain('3.2');
    expect(bodyText()).not.toContain('Medication updated from chat.');
    // The erase it reported has landed and shows: the banner goes.
    expect(bodyText()).not.toContain(ERASE_IN_PROGRESS);
  });

  it('erase still reading when the reply lands, then the erase stops short: the in-progress words go with it (A6 R2)', async () => {
    const adapter = new HeldCloud(new MemoryCloud());
    const view = await userOnStatin(adapter);
    await ask(view);
    const read = adapter.holdRead(true);
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => deleteButton()));
    await read.reached;
    await replyLands();
    expect(bodyText()).toContain(ERASE_IN_PROGRESS);
    read.release();
    await waitFor(() => expect(alert).toHaveBeenCalledWith(ERASE_UNREACHABLE));
    await wait(600);
    // Nothing was deleted: "being deleted" never stands beside that.
    expect(bodyText()).not.toContain(ERASE_IN_PROGRESS);
    expect(bodyText()).not.toContain(RECORD_CHANGED_SINCE_ASKED);
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

  /** The notice on screen: a question, this tab's erase, then the reply refused. */
  async function noticeShown(view: RenderResult) {
    await ask(view);
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => deleteButton()));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await wait(1500);
    await replyLands();
    expect(bodyText()).toContain(RECORD_CHANGED_SINCE_ASKED);
  }
  const chatPanel = (view: RenderResult) => view.container.querySelector('.health-tool-chat') as HTMLElement;
  async function openSavedChat(view: RenderResult) {
    fireEvent.click(chatPanel(view).querySelector('[aria-label="Show conversations"]')!);
    const row = await waitFor(() => {
      const r = Array.from(chatPanel(view).querySelectorAll('.chat-thread-title')).find((t) => t.textContent === 'Saved chat');
      expect(r).toBeTruthy();
      return r as HTMLElement;
    });
    await act(async () => { fireEvent.click(row); });
    await wait(100);
  }

  it('the notice goes at New chat', async () => {
    const view = await userOnStatin(new HeldCloud(new MemoryCloud()));
    await noticeShown(view);
    fireEvent.click(chatPanel(view).querySelector('[aria-label="Show conversations"]')!);
    fireEvent.click(chatPanel(view).querySelector('.chat-new-btn')!);
    await wait(100);
    expect(bodyText()).not.toContain(RECORD_CHANGED_SINCE_ASKED);
  });

  it('the notice goes when a saved chat is opened', async () => {
    const view = await userOnStatin(new HeldCloud(new MemoryCloud()));
    await noticeShown(view);
    await openSavedChat(view);
    expect(bodyText()).not.toContain(RECORD_CHANGED_SINCE_ASKED);
  });

  it('the notice goes when another tab starts a new chat', async () => {
    const view = await userOnStatin(new HeldCloud(new MemoryCloud()));
    await noticeShown(view);
    act(() => sync.hear!({ instanceId: 'other-tab', type: 'thread-new', payload: {}, ts: Date.now() }));
    await wait(100);
    expect(bodyText()).not.toContain(RECORD_CHANGED_SINCE_ASKED);
  });

  it('a refused reply for a thread no longer on screen says nothing in the new one, and applies nothing', async () => {
    const cloud = new MemoryCloud();
    const view = await userOnStatin(new HeldCloud(cloud));
    await ask(view);
    await openSavedChat(view);
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => deleteButton()));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await wait(1500);
    await replyLands();
    expect(bodyText()).not.toContain(RECORD_CHANGED_SINCE_ASKED);
    expect(await cloudMedications(cloud)).not.toContain('atorvastatin');
    expect(profileBanner()).toBeNull();
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

  // Chat-turn R6 (slice 2): the chat keeps its own copy of the erase shown, moved by useErase's mark effect.
  // Were it left at the old erase, every reply after an erase would read "Not saved".
  it('R6: a question asked after an erase: the reply\'s edits apply and say so', async () => {
    const cloud = new MemoryCloud();
    const view = await userOnStatin(new HeldCloud(cloud));
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => deleteButton()));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await wait(1500);
    await ask(view);
    await replyLands();
    expect(bodyText()).not.toContain(RECORD_CHANGED_SINCE_ASKED);
    expect(bodyText()).toContain('Medication updated from chat.');
    expect(await cloudMedications(cloud)).toContain('atorvastatin');
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

describe('US-16 AC2a (A6 R1): a profile save refused while this tab\'s erase reads, then the erase stops short', () => {
  it('the form shows the record stored, and a remote change held behind the unsaved edit is released', async () => {
    const cloud = new MemoryCloud();
    const adapter = new HeldCloud(cloud);
    vi.spyOn(RoadmapStore, 'create');
    const view = await userOnStatin(adapter);
    const field = (id: string) => view.container.querySelector<HTMLInputElement>(`#${id}`)!;
    fireEvent.change(field('heightCm'), { target: { value: '191' } });
    // Another device changes the birth year; the page holds it behind the unsaved height (US-34 AC4).
    const other = new MemoryAdapter(cloud);
    const { body, version } = await other.read(ROADMAP_FILE_NAME);
    const file = body as RoadmapFile;
    await other.write(ROADMAP_FILE_NAME, { ...file, profile: stampFields(file.profile, { birthYear: 1980 }, new Date(Date.now() + 1000).toISOString()) }, version);
    const created = vi.mocked(RoadmapStore.create).mock.results;
    await act(async () => { await (await (created[created.length - 1].value as Promise<RoadmapStore>)).refreshFromRemote(); });
    expect(field('birthYear').value).toBe('1974');
    const read = adapter.holdRead(true);
    const alert = vi.fn();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', alert);
    fireEvent.click(await waitFor(() => deleteButton()));
    await read.reached;
    await wait(800); // the profile save comes due while the erase reads, and is refused
    read.release();
    await waitFor(() => expect(alert).toHaveBeenCalledWith(ERASE_UNREACHABLE));
    await wait(600);
    await act(async () => { await flushRoadmapStore(); });
    const stored = ((await new MemoryAdapter(cloud).read(ROADMAP_FILE_NAME)).body as RoadmapFile).profile;
    expect({ heightCm: stored.heightCm, birthYear: stored.birthYear }).toEqual({ heightCm: 180, birthYear: 1980 });
    // The screen shows what is stored: the refused height is gone, the held birth year shows.
    expect({ heightCm: field('heightCm').value, birthYear: field('birthYear').value }).toEqual({ heightCm: '180', birthYear: '1980' });
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
