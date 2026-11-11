// @vitest-environment jsdom
/**
 * US-15 AC62 (Fable 2026-11-12, Codex R1-R3 on PR 1311): every async step of
 * the web chat checks, before it touches the screen, that what it was asked
 * under is still shown: the chat (its key) and the erase. These drive the
 * three ways it went wrong through the whole widget, a real RoadmapStore, the
 * real chat panel and chat-api, and a real ChatSession on a shared in-memory
 * cloud. The server's answer is a held NDJSON stream the test feeds line by
 * line; the chat file's first read can be held too. Synthetic data only.
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
import { RECORD_CHANGED_SINCE_ASKED } from '@roadmap/health-core/erase';

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
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), generateInstanceId: () => 'test', subscribeSync: () => () => {},
}));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

import { HealthTool } from './HealthTool';
import { deleteButton } from '../testing/settings';

const CHAT_FILE = 'chat-history.json';
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** The server's chat answer: each POST is held until the test opens its stream, then fed line by line. */
const server = {
  bodies: [] as Array<{ message: string; conversationId?: string }>,
  answer: null as null | ((r: Response) => void),
  lines: null as null | ReadableStreamDefaultController<Uint8Array>,
};

/** Opens the held answer as an NDJSON stream. */
async function openStream() {
  const body = new ReadableStream<Uint8Array>({ start(c) { server.lines = c; } });
  await act(async () => { server.answer!(new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })); });
}
/** One streamed line, then a frame for it to render. */
async function line(value: object) {
  await act(async () => { server.lines!.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n')); });
  await wait(50);
}
/** The stream's last line: the whole answer, here proposing a statin change. */
async function done(conversationId: string, content: string) {
  await line({
    type: 'done', success: true, conversationId, messageId: `m-${conversationId}`, content, isFallback: false,
    proposedEdits: [{ kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' }],
  });
  // The reader stops at `done` and may have cancelled the stream already.
  await act(async () => { try { server.lines!.close(); } catch { /* cancelled */ } });
  await wait(1500);
}

/** The cloud, as this page's adapter: `holdRead` keeps the chat file's next
 *  read, taken as it is now, until released. */
class HeldCloud extends MemoryAdapter {
  private gate: Promise<void> | null = null;
  holdRead() {
    let release!: () => void;
    this.gate = new Promise<void>((r) => { release = r; });
    return () => release();
  }
  override async read(name: string, signal?: AbortSignal) {
    const now = await super.read(name, signal);
    const gate = name === CHAT_FILE ? this.gate : null;
    if (gate) { this.gate = null; await gate; }
    return now;
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
  server.lines = null;
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
async function userOnStatin(beforeRender: () => void = () => {}): Promise<RenderResult> {
  await initRoadmapStore(adapter);
  await saveChangedMeasurements({ birthYear: 1974, birthMonth: 1, sex: 'male', heightCm: 180 }, {});
  await addMeasurement('weight', 82, '2026-09-01');
  await saveMedication('statin', 'rosuvastatin', 10, 'mg');
  await flushRoadmapStore();
  beforeRender();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.health-tool-chat textarea')).toBeTruthy());
  await wait(600);
  return view;
}

const chatPanel = (view: RenderResult) => view.container.querySelector('.health-tool-chat') as HTMLElement;
const chatText = (view: RenderResult) => chatPanel(view).textContent ?? '';
const bodyText = () => document.body.textContent ?? '';

/** The user asks in the real chat panel; the server's answer is held. */
async function ask(view: RenderResult, question: string) {
  const before = server.bodies.length;
  fireEvent.change(chatPanel(view).querySelector('textarea')!, { target: { value: question } });
  fireEvent.click(chatPanel(view).querySelector('[aria-label="Send"]')!);
  await waitFor(() => expect(server.bodies.length).toBe(before + 1));
}

/** This tab's "Delete all my data", to its alert. */
async function eraseHere() {
  fireEvent.click(await waitFor(() => deleteButton()));
  await waitFor(() => expect(vi.mocked(window.alert)).toHaveBeenCalled());
  await wait(1500);
}

/** Another device erases the record and its chat in the shared cloud, then
 *  saves a conversation of its own; this page then re-reads the cloud. */
async function otherDeviceErases() {
  const chat = await ChatHistoryStore.create(new MemoryAdapter(cloud));
  await chat.eraseAll();
  await chat.recordExchange({ conversationId: 'conv-after', isNew: true, userText: 'A synthetic thread saved after the erase', assistantText: 'Synthetic.' });
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

describe('US-15 AC62: no async chat step touches the screen once what it was asked under has gone', () => {
  it('R1: a new chat\'s streaming first reply leaves the screen as the erase shows, and no later line brings it back', async () => {
    const view = await userOnStatin();
    await ask(view, 'I switched to atorvastatin 20 mg');
    await openStream();
    await line({ type: 'text', text: 'Streaming synthetic words ' });
    expect(chatText(view)).toContain('Streaming synthetic words');
    await otherDeviceErases();
    expect(chatText(view)).not.toContain('Streaming synthetic words');
    await line({ type: 'text', text: 'and more synthetic words' });
    expect(chatText(view)).not.toContain('Streaming synthetic words');
    expect(chatText(view)).not.toContain('more synthetic words');
    await done('conv-1', 'Done, I have updated your statin.');
    expect(chatText(view)).not.toContain('synthetic words');
    expect(chatText(view)).not.toContain('updated your statin');
  });

  it('R2: a list read begun before the erase and landing after it names no erased thread, and the list is read again for the new erase', async () => {
    const seed = await ChatHistoryStore.create(new MemoryAdapter(cloud));
    await seed.recordExchange({ conversationId: 'conv-old', isNew: true, userText: 'An erased synthetic thread title', assistantText: 'Synthetic.' });
    let release = () => {};
    const view = await userOnStatin(() => { release = adapter.holdRead(); });
    await otherDeviceErases();
    await act(async () => { release(); });
    await wait(1500);
    expect(chatText(view)).not.toContain('An erased synthetic thread title');
    expect(chatText(view)).toContain('A synthetic thread saved after the erase');
  });

  it('R3: after an erase and then New chat, the erased reply landing late shows none of its words and no "Not saved" line', async () => {
    const view = await userOnStatin();
    await ask(view, 'I switched to atorvastatin 20 mg');
    await openStream();
    await line({ type: 'text', text: 'Streaming synthetic words ' });
    await eraseHere();
    fireEvent.click(chatPanel(view).querySelector('[aria-label="Show conversations"]')!);
    fireEvent.click(chatPanel(view).querySelector('.chat-new-btn')!);
    await wait(100);
    await line({ type: 'text', text: 'and more synthetic words' });
    await done('conv-1', 'Done, I have updated your statin.');
    expect(chatText(view)).not.toContain('synthetic words');
    expect(chatText(view)).not.toContain('updated your statin');
    expect(bodyText()).not.toContain(RECORD_CHANGED_SINCE_ASKED);
  });

  it('control: with no erase, the streamed reply shows as it arrives and lands', async () => {
    const view = await userOnStatin();
    await ask(view, 'I switched to atorvastatin 20 mg');
    await openStream();
    await line({ type: 'text', text: 'Streaming synthetic words ' });
    expect(chatText(view)).toContain('Streaming synthetic words');
    await done('conv-1', 'Done, I have updated your statin.');
    expect(chatText(view)).toContain('Done, I have updated your statin.');
  });
});
