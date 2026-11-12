/**
 * The web chat's turn, list and load as one state, changed only through a pure
 * `transition(state, event)` (the mode rule, .claude/skills/untangle). Every
 * async step's landing carries the number it was asked under; a landing whose
 * number is not current changes nothing. Effects are data the hook runs.
 * Design: the chat-turn reducer page, §1-§3. No DOM, no clock, no randomness:
 * the hook passes the time and a nonce in; numbers are minted from `seq`.
 */
import type { ChatEditRefusal } from './chat-edit-refusals';
import type { ProposedEdit } from './chat-edits';
import { cutText } from './chat-history';

export const MAX_CHARS = 8000;
export const OFFLINE_ERROR = "You're offline. Check your connection and try again.";

// Minimal shapes; the widget's chat-api types are wider and assign to these.
export interface Msg { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; isFallback?: boolean }
export interface Conv { id: string; title: string; updatedAt?: string; createdAt?: string }
export interface Approach { thinking: string; sources: string[] }
export interface Pending extends Approach { text: string; status: string }
export type Delta = { type: 'thinking' | 'text' | 'status'; text: string } | { type: 'sources'; titles: string[] };
export interface SendResult {
  conversationId: string; messageId: string | null; content: string; isFallback?: boolean;
  proposedEdits?: ProposedEdit[]; editRefusals?: ChatEditRefusal[]; subscriptionCard?: unknown;
}
/** Another tab's state post. `erase` is absent from an older bundle: it counts as this tab's. `loaded` false: that
 *  tab has not read its thread's turns (its load is not none), so its `messages` are no history; absent, they are. */
export interface MirrorPayload { conversations: Conv[]; activeConversationId: string | null; messages: Msg[]; error: string | null; erase?: Erase; loaded?: boolean }

export type Key = `new:${number}` | `thread:${string}`;
export type Erase = string;
export interface Asked { key: Key; erase: Erase }
export interface Shown { key: Key; id: string | null; opening: number }
type Moving = 'none' | 'own' | 'remote';

/**
 * `convId` is the request's thread id: after an erase the key can be `thread:x` with id null.
 * `nonce` names the turn's messages, unique across tabs and mounts (another tab's turn 1 can be mirrored here).
 */
export type Turn =
  | { phase: 'idle' }
  | { phase: 'sending'; turn: number; nonce: string; asked: Asked; convId: string | null; question: Msg; before: Msg[] }
  | { phase: 'streaming'; turn: number; nonce: string; asked: Asked; convId: string | null; question: Msg; before: Msg[]; pending: Pending }
  | { phase: 'orphaned'; turn: number; asked: Asked; by: 'own' | 'remote' };
/** `autoOpen`: a guest's first read, which opens the latest thread on landing unless the person moved first (Q7). */
export type List = { phase: 'unread' } | { phase: 'waiting'; autoOpen: boolean } | { phase: 'reading'; read: number; autoOpen: boolean } | { phase: 'read' };
/** `failed`: the shown thread's turns could not be read (not a 404). Send stays locked: a send must never carry a history it failed to read (N2). */
export type Load = { phase: 'none' } | { phase: 'loading'; opening: number; id: string } | { phase: 'failed'; opening: number; id: string };

export interface ChatState {
  shown: Shown; messages: Msg[]; conversations: Conv[];
  turn: Turn; list: List; load: Load;
  erase: { shown: Erase; moving: Moving };
  notice: 'none' | 'remote-erase'; error: string | null;
  seq: { key: number; opening: number; turn: number; read: number };
}

export type ChatEvent =
  | { type: 'send'; text: string; online: boolean; othersBusy: boolean; now: string; nonce: string } // now: ISO, the hook's clock
  | { type: 'delta'; turn: number; delta: Delta }
  | { type: 'done'; turn: number; result: SendResult; now: string }
  | { type: 'failed'; turn: number; message: string; boxEmpty: boolean }
  | { type: 'open-thread'; id: string }
  | { type: 'new-chat' }
  | { type: 'mirror-state'; payload: MirrorPayload }
  | { type: 'mirror-new' }
  | { type: 'thread-gone'; id: string; tell: boolean }
  | { type: 'erase-state'; moving: Moving }
  | { type: 'erase-shown'; erase: Erase; by: 'own' | 'remote' }
  | { type: 'list-wanted'; guest: boolean }
  | { type: 'list-landed'; read: number; conversations: Conv[] | null }
  | { type: 'load-landed'; opening: number; id: string; turns: Msg[] | null }
  | { type: 'load-failed'; opening: number; id: string } // a read that threw, timed out, or answered with no turns (not a 404)
  | { type: 'dismiss' };

export type Effect =
  | { type: 'request'; turn: number; question: string; convId: string | null; history: Msg[] }
  | { type: 'read-list'; read: number }
  | { type: 'read-turns'; opening: number; id: string }
  | { type: 'take-edits'; edits: ProposedEdit[]; refusals: ChatEditRefusal[]; erase: Erase; stayed: boolean }
  | { type: 'edits-ask' } | { type: 'edits-leave' }
  | { type: 'set-input'; text: string } | { type: 'focus-input' }
  | { type: 'keep-approach'; id: string; approach: Approach }
  | { type: 'add-card'; id: string; card: unknown }
  | { type: 'clear-extras' } | { type: 'remote-selected' }
  | { type: 'post-state' } | { type: 'post-new' } | { type: 'post-deleted'; id: string }
  | { type: 'own-ended' };

export interface Step { state: ChatState; effects: Effect[] }

const NO_PENDING: Pending = { thinking: '', sources: [], text: '', status: '' };

/** A prefetched list mounts read: nothing reads it again or opens a thread from it. `opened`: the prefetched thread shown. */
export function initialChatState(opts: { erase: Erase; moving: Moving; conversations?: Conv[]; opened?: { id: string; messages: Msg[] } }): ChatState {
  const { opened } = opts;
  return {
    shown: opened ? { key: `thread:${opened.id}`, id: opened.id, opening: 0 } : { key: 'new:0', id: null, opening: 0 },
    messages: opened?.messages ?? [], conversations: opts.conversations ?? [],
    turn: { phase: 'idle' }, list: opts.conversations ? { phase: 'read' } : { phase: 'unread' }, load: { phase: 'none' },
    erase: { shown: opts.erase, moving: opts.moving },
    notice: 'none', error: null,
    seq: { key: 0, opening: 0, turn: 0, read: 0 },
  };
}

// --- derived view -----------------------------------------------------------

/** This tab's own send, under the chat on screen. */
export function isLocalSender(s: ChatState): boolean {
  return (s.turn.phase === 'sending' || s.turn.phase === 'streaming') && s.turn.asked.key === s.shown.key;
}
/** The streamed reply, only from `streaming` under the chat that asked. */
export function showsPending(s: ChatState): Pending | null {
  return s.turn.phase === 'streaming' && s.turn.asked.key === s.shown.key ? s.turn.pending : null;
}
/** Locks Send, also while the shown thread loads or failed to; never draws the indicator. */
export function busy(s: ChatState, othersBusy: boolean): boolean {
  return s.turn.phase !== 'idle' || s.load.phase !== 'none' || othersBusy;
}

// --- transition -------------------------------------------------------------

const same = (state: ChatState): Step => ({ state, effects: [] });
const inFlight = (t: Turn): t is Extract<Turn, { phase: 'sending' | 'streaming' }> => t.phase === 'sending' || t.phase === 'streaming';

/** The person moved (a send, or another chat shown): a guest's first read no longer opens a thread (Q7). */
function settled(s: ChatState): ChatState {
  return s.list.phase === 'reading' || s.list.phase === 'waiting' ? { ...s, list: { ...s.list, autoOpen: false } } : s;
}
/** The first chat, never sent from or left: only then may a guest's first read open a thread (Q7). */
const untouched = (s: ChatState): boolean => s.shown.key === 'new:0' && s.turn.phase === 'idle' && s.messages.length === 0;

/** A new shown chat with no thread (New chat, its mirror, a thread gone): its own key and opening. */
function freshChat(s: ChatState): ChatState {
  const seq = { ...s.seq, key: s.seq.key + 1, opening: s.seq.opening + 1 };
  return { ...settled(s), seq, shown: { key: `new:${seq.key}`, id: null, opening: seq.opening }, messages: [], error: null, notice: 'none', load: { phase: 'none' } };
}

/** Shows thread `id` under a new opening. */
function openThread(s: ChatState, id: string): ChatState {
  const seq = { ...s.seq, opening: s.seq.opening + 1 };
  return { ...settled(s), seq, shown: { key: `thread:${id}`, id, opening: seq.opening } };
}

function readList(s: ChatState, autoOpen: boolean): Step {
  const seq = { ...s.seq, read: s.seq.read + 1 };
  return { state: { ...s, seq, list: { phase: 'reading', read: seq.read, autoOpen } }, effects: [{ type: 'read-list', read: seq.read }] };
}

function applyDelta(p: Pending, d: Delta): Pending {
  if (d.type === 'sources') return { ...p, sources: d.titles };
  if (d.type === 'status') return { ...p, status: d.text, text: '' }; // AC38: what streamed before was not the answer
  return { ...p, [d.type]: p[d.type] + d.text };
}

function takeEdits(r: SendResult, erase: Erase, stayed: boolean): Effect[] {
  if (!r.proposedEdits?.length && !r.editRefusals?.length) return [];
  return [{ type: 'take-edits', edits: r.proposedEdits ?? [], refusals: r.editRefusals ?? [], erase, stayed }];
}

function send(s: ChatState, e: Extract<ChatEvent, { type: 'send' }>): Step {
  const text = e.text.trim();
  // busy(), and the shown thread still loading or failed to: its turns are not the history (US-15 AC7a, N2).
  if (busy(s, e.othersBusy) || s.erase.moving !== 'none' || !text || text.length > MAX_CHARS) return same(s);
  if (!e.online) return same({ ...s, error: OFFLINE_ERROR });
  const turn = s.seq.turn + 1;
  const question: Msg = { id: `temp-${e.nonce}`, role: 'user', content: text, createdAt: e.now };
  const asked: Asked = { key: s.shown.key, erase: s.erase.shown };
  return {
    state: {
      ...settled(s), seq: { ...s.seq, turn }, messages: [...s.messages, question], notice: 'none', error: null,
      turn: { phase: 'sending', turn, nonce: e.nonce, asked, convId: s.shown.id, question, before: s.messages },
    },
    effects: [
      { type: 'set-input', text: '' }, { type: 'edits-ask' }, { type: 'post-state' },
      { type: 'request', turn, question: text, convId: s.shown.id, history: s.messages },
    ],
  };
}

function done(s: ChatState, t: Extract<Turn, { phase: 'sending' | 'streaming' }>, r: SendResult, now: string): Step {
  const idle: ChatState = { ...s, turn: { phase: 'idle' } };
  const ended: Effect[] = [{ type: 'post-state' }, { type: 'own-ended' }];
  const restarted = t.convId !== null && r.conversationId !== t.convId;
  const saved = t.convId === null || restarted; // a new thread on the server
  const conversations = saved
    ? [{ id: r.conversationId, title: cutText(t.question.content, 80) }, ...s.conversations.filter((c) => c.id !== t.convId && c.id !== r.conversationId)]
    : s.conversations;
  if (t.asked.key !== s.shown.key) { // left: the reply stays with the thread it was sent from (AC7a)
    return { state: { ...idle, conversations }, effects: [...takeEdits(r, t.asked.erase, false), ...ended] };
  }
  const answer: Msg = { id: r.messageId ?? `assistant-${t.nonce}`, role: 'assistant', content: r.content, createdAt: now, ...(r.isFallback ? { isFallback: true } : {}) };
  let state: ChatState = {
    ...idle, conversations, load: { phase: 'none' }, // a reply is newer than any load (AC7a)
    messages: [...(restarted ? [] : t.before), t.question, answer],
  };
  if (saved) state = openThread(state, r.conversationId);
  const effects: Effect[] = restarted ? [{ type: 'edits-leave' }] : []; // a new thread (AC6a)
  const approach = t.phase === 'streaming' ? { thinking: t.pending.thinking, sources: t.pending.sources } : null;
  if (approach && (approach.thinking || approach.sources.length) && !r.isFallback) effects.push({ type: 'keep-approach', id: answer.id, approach });
  if (r.subscriptionCard) effects.push({ type: 'add-card', id: answer.id, card: r.subscriptionCard });
  return { state, effects: [...effects, ...takeEdits(r, t.asked.erase, true), ...ended] };
}

function turnStep(s: ChatState, e: Extract<ChatEvent, { type: 'delta' | 'done' | 'failed' }>): Step {
  const t = s.turn;
  if (t.phase === 'idle' || t.turn !== e.turn) return same(s);
  const ended: Effect[] = [{ type: 'post-state' }, { type: 'own-ended' }];
  if (t.phase === 'orphaned') {
    if (e.type === 'delta') return same(s);
    const idle: ChatState = { ...s, turn: { phase: 'idle' } };
    if (e.type === 'failed') return { state: idle, effects: ended }; // Decision Q2: no question back, no error
    const stayed = t.asked.key === s.shown.key && t.by === 'own'; // own: "Not saved" (US-16 AC2e)
    return { state: idle, effects: [...takeEdits(e.result, t.asked.erase, stayed), ...ended] };
  }
  if (e.type === 'delta') {
    const pending = applyDelta(t.phase === 'streaming' ? t.pending : NO_PENDING, e.delta);
    return same({ ...s, turn: { ...t, phase: 'streaming', pending } });
  }
  if (e.type === 'done') return done(s, t, e.result, e.now);
  if (t.asked.key !== s.shown.key) return { state: { ...s, turn: { phase: 'idle' }, error: e.message }, effects: ended };
  const back: Effect[] = e.boxEmpty ? [{ type: 'set-input', text: t.question.content }] : []; // AC57
  return { state: { ...s, turn: { phase: 'idle' }, messages: t.before, error: e.message }, effects: [...back, ...ended] };
}

function eraseShown(s: ChatState, e: Extract<ChatEvent, { type: 'erase-shown' }>): Step {
  if (e.erase === s.erase.shown) return same(s);
  const seq = { ...s.seq, opening: s.seq.opening + 1 };
  const turn: Turn = inFlight(s.turn) ? { phase: 'orphaned', turn: s.turn.turn, asked: s.turn.asked, by: e.by } : s.turn;
  const next: ChatState = {
    ...s, seq, turn, erase: { ...s.erase, shown: e.erase },
    shown: { ...s.shown, id: null, opening: seq.opening }, messages: [], conversations: [], error: null,
    notice: e.by === 'own' ? 'none' : 'remote-erase', load: { phase: 'none' },
  };
  const effects: Effect[] = [{ type: 'clear-extras' }, ...(e.by === 'remote' ? [{ type: 'edits-leave' } as const] : [])];
  if (next.list.phase === 'unread') return { state: next, effects };
  const read = readList(next, false); // a read after an erase never opens a thread (Q7)
  return { state: read.state, effects: [...effects, ...read.effects] };
}

function listLanded(s: ChatState, e: Extract<ChatEvent, { type: 'list-landed' }>): Step {
  if (s.list.phase !== 'reading' || s.list.read !== e.read) return same(s);
  const next: ChatState = { ...s, list: { phase: 'read' }, conversations: e.conversations ?? s.conversations };
  const latest = e.conversations?.[0];
  if (!s.list.autoOpen || !latest) return same(next);
  const opened = openThread(next, latest.id); // Decision Q7: a guest's first read opens the latest thread
  return { state: { ...opened, load: { phase: 'loading', opening: opened.shown.opening, id: latest.id } }, effects: [{ type: 'read-turns', opening: opened.shown.opening, id: latest.id }] };
}

/** The landing is for the load in flight; any other is stale. */
const loadsNow = (s: ChatState, e: { opening: number; id: string }): boolean => s.load.phase === 'loading' && s.load.opening === e.opening && s.load.id === e.id;

function loadLanded(s: ChatState, e: Extract<ChatEvent, { type: 'load-landed' }>): Step {
  const current = loadsNow(s, e);
  if (e.turns) {
    if (!current) return same(s);
    return { state: { ...s, messages: e.turns, load: { phase: 'none' } }, effects: [{ type: 'post-state' }] };
  }
  // A 404 at any opening: the thread is gone (AC6a). R8: emptying the shown chat also ends its load.
  const dropped: ChatState = { ...s, conversations: s.conversations.filter((c) => c.id !== e.id) };
  if (s.shown.id === e.id) return { state: freshChat(dropped), effects: [{ type: 'edits-leave' }] };
  return same(dropped); // a load is only ever for the shown thread (property test), so this one is not loading
}

export function transition(s: ChatState, e: ChatEvent): Step {
  switch (e.type) {
    case 'send': return send(s, e);
    case 'delta': case 'done': case 'failed': return turnStep(s, e);
    case 'open-thread': {
      const opened = openThread({ ...s, messages: [], error: null, notice: 'none' }, e.id); // empty while it loads
      const opening = opened.shown.opening;
      return { state: { ...opened, load: { phase: 'loading', opening, id: e.id } }, effects: [{ type: 'edits-leave' }, { type: 'read-turns', opening, id: e.id }] };
    }
    case 'new-chat': return { state: freshChat(s), effects: [{ type: 'edits-leave' }, { type: 'focus-input' }, { type: 'post-new' }] };
    case 'mirror-new': return { state: freshChat(s), effects: [{ type: 'edits-leave' }] };
    case 'mirror-state': {
      const p = e.payload;
      if ((p.erase ?? s.erase.shown) !== s.erase.shown) return same(s);
      const id = p.activeConversationId;
      const moved: Effect[] = [{ type: 'remote-selected' }, { type: 'edits-leave' }];
      if (p.loaded === false) { // R1: its turns are no history; this tab keeps its own, or reads the thread itself
        const kept: ChatState = { ...s, conversations: p.conversations, error: p.error };
        if (id === s.shown.id) return same(kept);
        if (id === null) return { state: { ...freshChat(kept), error: p.error, notice: s.notice }, effects: moved };
        const opened = openThread({ ...kept, messages: [] }, id);
        const opening = opened.shown.opening;
        return { state: { ...opened, load: { phase: 'loading', opening, id } }, effects: [...moved, { type: 'read-turns', opening, id }] };
      }
      const base: ChatState = { ...s, messages: p.messages, conversations: p.conversations, error: p.error, load: { phase: 'none' } };
      if (id === s.shown.id) return same(base);
      const next = id === null ? { ...freshChat(base), messages: p.messages, error: p.error, notice: s.notice } : openThread(base, id);
      return { state: next, effects: moved };
    }
    case 'thread-gone': {
      const dropped: ChatState = { ...s, conversations: s.conversations.filter((c) => c.id !== e.id) };
      const tell: Effect[] = e.tell ? [{ type: 'post-deleted', id: e.id }] : [];
      if (s.shown.id !== e.id) return { state: dropped, effects: tell };
      return { state: freshChat(dropped), effects: [{ type: 'edits-leave' }, ...tell] };
    }
    case 'erase-state': {
      const was = s.erase.moving;
      const next: ChatState = { ...s, erase: { ...s.erase, moving: e.moving } };
      if (was === 'none' && e.moving !== 'none' && s.list.phase === 'reading') return same({ ...next, list: { phase: 'waiting', autoOpen: s.list.autoOpen } }); // read dropped
      if (was !== 'none' && e.moving === 'none' && s.list.phase === 'waiting') return readList(next, s.list.autoOpen);
      return same(next);
    }
    case 'erase-shown': return eraseShown(s, e);
    case 'list-wanted': {
      if (s.list.phase !== 'unread') return same(s);
      const autoOpen = e.guest && untouched(s);
      return s.erase.moving !== 'none' ? same({ ...s, list: { phase: 'waiting', autoOpen } }) : readList(s, autoOpen);
    }
    case 'list-landed': return listLanded(s, e);
    case 'load-landed': return loadLanded(s, e);
    case 'load-failed': return same(loadsNow(s, e) ? { ...s, load: { phase: 'failed', opening: e.opening, id: e.id } } : s);
    case 'dismiss': return same({ ...s, notice: 'none' });
  }
}
