// @vitest-environment jsdom
/**
 * US-15 AC62 (D9, C9): an erase clears the web chat's conversation, this
 * tab's erase or another device's once this tab shows it, and no erased turn
 * goes back to the server as history. A reply to a question asked before the
 * erase is never saved into the chat-history file, so no saved thread shows a
 * reply claiming a change the erased record does not hold (US-16 AC2e).
 * Before, the transcript stayed on screen and went out as history with the
 * next question, and a reply landing after the erase's chat tombstones was
 * saved as a live thread.
 *
 * The whole widget renders over a real RoadmapStore, the real chat panel
 * (ChatEmbed, useChatState), the real chat-api and a real ChatSession on a
 * shared in-memory cloud. Only the server's answer is a stand-in, held until
 * the test releases it. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act, type RenderResult } from '@testing-library/react';
import { CURRENT_SCHEMA_VERSION } from '@roadmap/health-core/roadmap-file';
import { rowRootIds } from '@roadmap/health-core/merge';
import { migrateFile } from '@roadmap/health-core/migrate';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { ChatHistoryStore } from '../storage/chat-history-store';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements, saveMedication } from '../lib/roadmap-data';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: (_el: Element, onChange: (v: boolean) => void) => { onChange(true); return () => {}; } }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
/** Another tab's chat messages, as this tab's BroadcastChannel hears them. */
const sync = vi.hoisted(() => ({ hear: null as null | ((msg: unknown) => void) }));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), generateInstanceId: () => 'test',
  subscribeSync: (hear: (msg: unknown) => void) => { sync.hear = hear; return () => {}; },
}));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

import { HealthTool } from './HealthTool';
import { deleteButton } from '../testing/settings';

const CHAT_FILE = 'chat-history.json';
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** The server's chat answers: each POST is held until the test answers it. */
const server = { bodies: [] as Array<{ message: string; conversationId?: string; history?: Array<{ content: string }> }>, answer: null as null | ((r: Response) => void) };

/** The cloud, as this page's adapter: `hold` stops the erase's chat
 *  tombstones at their cloud write until released. */
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
    const tombstones = (body as { conversations?: Array<{ deleted?: boolean }> }).conversations?.some((c) => c.deleted);
    if (this.gate && name === CHAT_FILE && tombstones) {
      this.entered();
      await this.gate;
    }
    return super.write(name, body, version, signal);
  }
}

let cloud: MemoryCloud;
let adapter: HeldCloud;
const stores: Array<Promise<RoadmapStore>> = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(() => () => {});
  const create = RoadmapStore.create.bind(RoadmapStore);
  vi.spyOn(RoadmapStore, 'create').mockImplementation((...args) => { const s = create(...args); stores.push(s); return s; });
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/chat') && init?.method === 'POST') {
      server.bodies.push(JSON.parse(String(init.body)));
      return new Promise<Response>((resolve) => { server.answer = resolve; });
    }
    if (String(url).endsWith('/api/events')) return new Response('{"success":true}');
    throw new Error('Synthetic test: no network');
  }));
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', vi.fn());
  Element.prototype.scrollIntoView ??= () => {};
  server.bodies = [];
  server.answer = null;
  cloud = new MemoryCloud();
  adapter = new HeldCloud(cloud);
});
afterEach(async () => {
  cleanup();
  await flushRoadmapStore();
  stores.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A synthetic returning user on rosuvastatin, with the chat column open. */
async function userOnStatin(): Promise<RenderResult> {
  await initRoadmapStore(adapter);
  await saveChangedMeasurements({ birthYear: 1974, birthMonth: 1, sex: 'male', heightCm: 180 }, {});
  await addMeasurement('weight', 82, '2026-09-01');
  await saveMedication('statin', 'rosuvastatin', 10, 'mg');
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.health-tool-chat textarea')).toBeTruthy());
  await wait(600);
  return view;
}

const chatPanel = (view: RenderResult) => view.container.querySelector('.health-tool-chat') as HTMLElement;
const chatText = (view: RenderResult) => chatPanel(view).textContent ?? '';

/** The user asks in the real chat panel; the server's answer is held. */
async function ask(view: RenderResult, question: string) {
  const before = server.bodies.length;
  fireEvent.change(chatPanel(view).querySelector('textarea')!, { target: { value: question } });
  fireEvent.click(chatPanel(view).querySelector('[aria-label="Send"]')!);
  await waitFor(() => expect(server.bodies.length).toBe(before + 1));
  return server.bodies[before];
}

/** The server answers the held question. */
async function answer(conversationId: string, content: string, withEdit = false) {
  const body = {
    success: true, conversationId, messageId: `m-${conversationId}`, content,
    ...(withEdit ? { proposedEdits: [{ kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' }] } : {}),
  };
  await act(async () => { server.answer!(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })); });
  await wait(1500);
}

/** This tab's "Delete all my data", to its alert. */
async function eraseHere() {
  fireEvent.click(await waitFor(() => deleteButton()));
  await waitFor(() => expect(vi.mocked(window.alert)).toHaveBeenCalled());
  await wait(1500);
}

/** Another device erases the record and its chat in the shared cloud, as its
 *  deleteUserData writes them; this page then re-reads the cloud. */
async function otherDeviceErases() {
  const chat = await ChatHistoryStore.create(new MemoryAdapter(cloud));
  await chat.eraseAll();
  const other = new MemoryAdapter(cloud);
  const { body, version } = await other.read(ROADMAP_FILE_NAME);
  const now = new Date(Date.now() + 1000).toISOString();
  const prior = migrateFile(body, { deviceId: 'other-device', now });
  const erased = migrateFile(null, { deviceId: 'other-device', now });
  const epoch = (prior.meta.eraseEpoch ?? 0) + 1;
  erased.schemaVersion = CURRENT_SCHEMA_VERSION;
  erased.erasedRows = { fromEpoch: epoch, ids: [...new Set(rowRootIds(prior))].sort() };
  erased.meta.eraseEpoch = epoch;
  erased.meta.erasedAt = now;
  await other.write(ROADMAP_FILE_NAME, erased, version);
  await act(async () => { await (await stores[stores.length - 1]).refreshFromRemote(); });
  await wait(1500);
}

/** The chat-history file in the cloud, as text. */
const savedChat = async () => {
  await wait(1500);
  return JSON.stringify((await new MemoryAdapter(cloud).read(CHAT_FILE)).body ?? null);
};

describe('US-15 AC62: an erase clears the web chat\'s conversation', () => {
  it('this tab\'s erase empties the transcript, and the next question sends no earlier turn as history', async () => {
    const view = await userOnStatin();
    await ask(view, 'First question about my synthetic LDL');
    await answer('conv-1', 'First synthetic answer.');
    expect(chatText(view)).toContain('First synthetic answer.');
    await eraseHere();
    expect(chatText(view)).not.toContain('First question about my synthetic LDL');
    expect(chatText(view)).not.toContain('First synthetic answer.');
    const next = await ask(view, 'A question after the erase');
    expect(next.conversationId).toBeUndefined();
    expect(JSON.stringify(next.history ?? [])).not.toContain('First');
  });

  it('another device\'s erase, once this tab shows it, empties the transcript, and the next question sends no earlier turn', async () => {
    const view = await userOnStatin();
    await ask(view, 'First question about my synthetic LDL');
    await answer('conv-1', 'First synthetic answer.');
    expect(chatText(view)).toContain('First synthetic answer.');
    await otherDeviceErases();
    expect(chatText(view)).not.toContain('First question about my synthetic LDL');
    expect(chatText(view)).not.toContain('First synthetic answer.');
    const next = await ask(view, 'A question after the erase');
    expect(next.conversationId).toBeUndefined();
    expect(JSON.stringify(next.history ?? [])).not.toContain('First');
  });
});

describe('US-15 AC62: another tab\'s conversation from before the erase is not mirrored in', () => {
  const otherTabState = (erase?: string) => ({
    instanceId: 'other-tab', type: 'state', ts: Date.now(),
    payload: {
      conversations: [{ id: 'conv-1', title: 'First', updatedAt: 'x', createdAt: 'x' }], activeConversationId: 'conv-1',
      messages: [{ id: 'q', role: 'user', content: 'First question from the other tab', createdAt: 'x' }],
      isLoading: false, sending: false, error: null, ...(erase !== undefined ? { erase } : {}),
    },
  });

  it('a tab still at the old erase: its conversation stays out, and the next question sends none of it', async () => {
    const view = await userOnStatin();
    await eraseHere();
    act(() => sync.hear!(otherTabState('a-pre-erase-identity')));
    await wait(100);
    expect(chatText(view)).not.toContain('First question from the other tab');
    const next = await ask(view, 'A question after the erase');
    expect(next.conversationId).toBeUndefined();
    expect(JSON.stringify(next.history ?? [])).not.toContain('other tab');
  });

  it('control: an older bundle\'s state, which names no erase, is mirrored as before', async () => {
    const view = await userOnStatin();
    act(() => sync.hear!(otherTabState()));
    await wait(100);
    expect(chatText(view)).toContain('First question from the other tab');
  });
});

describe('US-15 AC62 (C9): after an erase, no saved chat thread shows a reply claiming an erased change', () => {
  it('a reply landing after the erase is not saved, and not shown', async () => {
    const view = await userOnStatin();
    await ask(view, 'I switched to atorvastatin 20 mg');
    await eraseHere();
    await answer('conv-1', 'Done, I have updated your statin.', true);
    expect(await savedChat()).not.toContain('updated your statin');
    expect(chatText(view)).not.toContain('Done, I have updated your statin.');
  });

  it('a reply landing while the erase writes its chat tombstones is not saved', async () => {
    const view = await userOnStatin();
    // An earlier conversation, so the erase has a tombstone to write.
    await ask(view, 'An earlier synthetic question');
    await answer('conv-0', 'An earlier synthetic answer.');
    fireEvent.click(chatPanel(view).querySelector('[aria-label="Show conversations"]')!);
    fireEvent.click(chatPanel(view).querySelector('.chat-new-btn')!);
    await ask(view, 'I switched to atorvastatin 20 mg');
    const held = adapter.hold();
    fireEvent.click(await waitFor(() => deleteButton()));
    await held.reached;
    await answer('conv-1', 'Done, I have updated your statin.', true);
    held.release();
    await waitFor(() => expect(vi.mocked(window.alert)).toHaveBeenCalled());
    await wait(1500);
    expect(await savedChat()).not.toContain('updated your statin');
    expect(chatText(view)).not.toContain('Done, I have updated your statin.');
  });

  it('control: with no erase, the exchange is saved and shown', async () => {
    const view = await userOnStatin();
    await ask(view, 'I switched to atorvastatin 20 mg');
    await answer('conv-1', 'Done, I have updated your statin.', true);
    expect(chatText(view)).toContain('Done, I have updated your statin.');
    expect(await savedChat()).toContain('updated your statin');
  });
});
