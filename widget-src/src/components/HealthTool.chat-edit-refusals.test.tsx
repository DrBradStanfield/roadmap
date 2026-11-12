// @vitest-environment jsdom
/**
 * US-67 AC2: a reply's edits are read once, in chat-api's sendMessage, and an
 * entry of a known kind that is not its shape refuses every edit of its part,
 * with the iPhone's words, each beside its own part's banner. The refusal shows
 * only while the turn's thread and erase are still the ones on screen; after a
 * switch to another thread it is dropped from the screen and still reported to
 * Sentry by kind alone.
 *
 * The whole widget renders over a real RoadmapStore, the real chat panel and
 * the real sendMessage; only the network is a stand-in, held until released.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act, type RenderResult } from '@testing-library/react';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { CHAT_MEDS_UNREADABLE, CHAT_VALUES_UNREADABLE } from '@roadmap/health-core/chat-edit-refusals';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements, saveMedication } from '../lib/roadmap-data';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@sentry/react', async (original) => ({ ...(await original<typeof import('@sentry/react')>()), ...sentry }));
vi.mock('../lib/sentry', () => ({ Sentry: sentry }));
vi.mock('../lib/build-flags', async (original) => ({ ...(await original<typeof import('../lib/build-flags')>()), LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/chat-history-access', async (original) => ({ ...(await original<typeof import('../lib/chat-history-access')>()), getChatHistory: () => Promise.resolve(null), askChatHistory: () => Promise.resolve({ store: null }) }));
// The real sendMessage; the thread list is a stand-in.
vi.mock('../lib/chat-api', async (original) => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  getChatGate: () => null,
  listConversations: async () => ({ conversations: [{ id: 'saved-1', title: 'Saved chat', updatedAt: 'x', createdAt: 'x' }] }),
  loadConversation: async () => [{ id: 'saved-q', role: 'user', content: 'An older question', createdAt: 'x' }],
  deleteConversation: async () => true,
}));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), generateInstanceId: () => 'test', subscribeSync: () => () => {},
}));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: (_el: Element, onChange: (v: boolean) => void) => { onChange(true); return () => {}; } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

import { HealthTool } from './HealthTool';

/** The chat's one request, held until the test answers it with a streamed `done` line. */
const net = { sent: 0, answer: null as null | ((proposedEdits: unknown[]) => void) };
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const statin = { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' };
const badEscalation = { kind: 'medication', medicationKey: 'statin_escalation', drugName: 42, doseValue: null, doseUnit: null };
const ldl = { kind: 'field', field: 'ldlC', displayValue: 3.2, unitSystem: 'si', date: null };
const badLdl = { kind: 'field', field: 'ldlC', displayValue: '3.2', unitSystem: 'si', date: null };

/** A synthetic user on rosuvastatin who said they did not tolerate a higher dose. */
async function userOnStatin(cloud: MemoryCloud): Promise<RenderResult> {
  await initRoadmapStore(new MemoryAdapter(cloud));
  await saveChangedMeasurements({ birthYear: 1974, birthMonth: 1, sex: 'male', heightCm: 180 }, {});
  await addMeasurement('weight', 82, '2026-09-01');
  await saveMedication('statin', 'rosuvastatin', 10, 'mg');
  await saveMedication('statin_escalation', 'not_tolerated', null, null);
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.health-tool-chat textarea')).toBeTruthy());
  await wait(600);
  return view;
}

async function ask(view: RenderResult) {
  const before = net.sent;
  fireEvent.change(view.container.querySelector('.health-tool-chat textarea')!, { target: { value: 'I switched to atorvastatin 20 mg' } });
  fireEvent.click(view.container.querySelector('.health-tool-chat [aria-label="Send"]')!);
  await waitFor(() => expect(net.sent).toBe(before + 1));
}

async function replyLands(proposedEdits: unknown[]) {
  await act(async () => { net.answer!(proposedEdits); });
  await wait(1500);
}

async function openSavedChat(view: RenderResult) {
  const panel = view.container.querySelector('.health-tool-chat') as HTMLElement;
  fireEvent.click(panel.querySelector('[aria-label="Show conversations"]')!);
  const row = await waitFor(() => {
    const r = Array.from(panel.querySelectorAll('.chat-thread-title')).find((t) => t.textContent === 'Saved chat');
    expect(r).toBeTruthy();
    return r as HTMLElement;
  });
  await act(async () => { fireEvent.click(row); });
  await wait(100);
}

const cloudMedications = async (cloud: MemoryCloud) => {
  await act(async () => { await flushRoadmapStore(); });
  return JSON.stringify(((await new MemoryAdapter(cloud).read(ROADMAP_FILE_NAME)).body as RoadmapFile).medications);
};
const bodyText = () => document.body.textContent ?? '';
const refusal = (part: string) => document.body.querySelector(`.chat-edit-refusal[data-part="${part}"]`);
const reportedKinds = () => sentry.captureMessage.mock.calls.filter(([m]) => m === 'Chat edits unreadable').map(([, o]) => o);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(() => () => {});
  localStorage.clear();
  sessionStorage.clear();
  sentry.captureMessage.mockClear();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} }));
  net.sent = 0;
  net.answer = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!String(url).endsWith('/api/chat')) throw new Error('Synthetic test: no network');
    net.sent += 1;
    return new Promise<Response>((resolve) => {
      net.answer = (proposedEdits) => resolve(new Response(JSON.stringify({
        type: 'done', success: true, conversationId: 'conv-1', messageId: 'msg-1', content: 'Done, I have updated your statin.', isFallback: false, proposedEdits,
      }) + '\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
    });
  }));
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(async () => {
  cleanup();
  await flushRoadmapStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('US-67 AC2: an unreadable entry refuses its part, on screen only for the turn still shown', () => {
  it('a valid statin change beside a malformed escalation: nothing of the medications saves, the answer stays, the phone\'s words show', async () => {
    const cloud = new MemoryCloud();
    const view = await userOnStatin(cloud);
    await ask(view);
    await replyLands([statin, badEscalation]);
    const meds = await cloudMedications(cloud);
    expect(meds).not.toContain('atorvastatin');
    expect(meds).not.toContain('not_yet'); // the statin change would have reset the escalation answer
    expect(meds).toContain('not_tolerated');
    expect(refusal('medications')?.textContent).toContain(CHAT_MEDS_UNREADABLE);
    expect(refusal('review')).toBeNull();
    expect(bodyText()).not.toContain('Medication updated from chat.');
    expect(reportedKinds()).toEqual([{ level: 'warning', tags: { feature: 'chat-edits', invalid: 'medication' } }]);
  });

  it('a refused values part sits in its own banner; the medication line beside it says nothing of what was not saved', async () => {
    const cloud = new MemoryCloud();
    const view = await userOnStatin(cloud);
    await ask(view);
    await replyLands([statin, badLdl, ldl]);
    expect(await cloudMedications(cloud)).toContain('atorvastatin');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY) ?? '').not.toContain('3.2');
    const review = refusal('review')!;
    expect(review.textContent).toContain(CHAT_VALUES_UNREADABLE);
    expect(review.textContent).not.toContain('Medication updated');
    const medLine = Array.from(document.body.querySelectorAll('.chat-med-undo')).find((b) => b.textContent?.includes('Medication updated from chat.'))!;
    expect(medLine.textContent).not.toMatch(/could not be read|not saved|none of them/);
    expect(refusal('medications')).toBeNull();
  });

  it('a refusal for thread A that lands after a switch to thread B: dropped from the screen, nothing applied, still reported by kind', async () => {
    const cloud = new MemoryCloud();
    const view = await userOnStatin(cloud);
    await ask(view);
    await openSavedChat(view);
    await replyLands([statin, badEscalation, ldl]);
    expect(bodyText()).not.toContain(CHAT_MEDS_UNREADABLE);
    expect(document.body.querySelector('.chat-edit-refusal')).toBeNull();
    expect(await cloudMedications(cloud)).not.toContain('atorvastatin');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY) ?? '').not.toContain('3.2');
    expect(reportedKinds()).toEqual([{ level: 'warning', tags: { feature: 'chat-edits', invalid: 'medication' } }]);
  });

  // Two fresh chats both have no server id yet; each has its own local identity, so
  // the first one's reply never lands in the second.
  it('a first question in a fresh chat, then New chat while its reply is pending: no edit, no refusal, no Undo in the new chat', async () => {
    const cloud = new MemoryCloud();
    const view = await userOnStatin(cloud);
    const newChat = async () => {
      const panel = view.container.querySelector('.health-tool-chat') as HTMLElement;
      fireEvent.click(panel.querySelector('[aria-label="Show conversations"]')!);
      await act(async () => { fireEvent.click(panel.querySelector('.chat-new-btn')!); });
    };
    await newChat();
    await ask(view);
    await newChat();
    await replyLands([statin, badLdl, ldl]);
    expect(await cloudMedications(cloud)).not.toContain('atorvastatin');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY) ?? '').not.toContain('3.2');
    expect(document.body.querySelector('.chat-edit-refusal')).toBeNull();
    expect(bodyText()).not.toContain('Medication updated from chat.');
    expect(Array.from(document.body.querySelectorAll('.chat-banners button')).some((b) => b.textContent === 'Undo')).toBe(false);
    expect(reportedKinds()).toEqual([{ level: 'warning', tags: { feature: 'chat-edits', invalid: 'field' } }]);
  });
});
