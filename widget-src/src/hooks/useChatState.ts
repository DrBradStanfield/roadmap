/**
 * Shared chat state hook used by ChatSection (bubble) and ChatEmbed (inline panel).
 * The turn, the shown chat, the list and the load live in one chat-turn store
 * (hooks/chatStore.ts, packages/health-core/src/chat-turn.ts): every action and
 * every landing is an event, and the effects the store returns run here, each
 * through today's door (chat-api, chat-sync, ChatEdits). UI-only state
 * (isExpanded, showThreads, etc.) stays in the consuming component.
 */

import { Sentry } from '../lib/sentry';
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import {
  listConversations,
  sendMessage,
  deleteConversation,
  type ChatApproach,
  type ChatConversation,
  type ChatDelta,
  type ChatMessage,
  type ChatPending,
} from '../lib/chat-api';
import { postSync, postInputSync, subscribeSync, generateInstanceId } from '../lib/chat-sync';
import { getShownErase } from '../lib/roadmap-data';
import { useChatBusy } from './useChatBusy';
import { useOffline } from './useOffline';
import { createChatStore, joinChats } from './chatStore';
import { readThread } from './chatReads';
import { cutText } from '@roadmap/health-core/chat-history';
import { busy, initialChatState, isLocalSender, MAX_CHARS, showsPending, type ChatEvent, type Effect } from '@roadmap/health-core/chat-turn';
import type { ChatContextPayload } from '@roadmap/health-core/chat-context';
import type { ProposedEdit } from '@roadmap/health-core/chat-edits';
import type { ChatEditRefusal } from '@roadmap/health-core/chat-edit-refusals';
import { confirmSubscriptionChange, type SubscriptionCard, type SubscriptionResult } from '../lib/subscription-card';

export { MAX_CHARS };

/** A subscription change card under an answer (US-59): idle, sending, or closed with its outcome. */
export interface SubscriptionCardState {
  card: SubscriptionCard;
  phase: 'idle' | 'sending' | 'closed';
  /** The last outcome; a 'busy' one leaves the card open to try again. */
  result?: SubscriptionResult;
  dismissed?: boolean;
}

export interface ChatPrefetchData {
  conversations: ChatConversation[];
  messages: ChatMessage[];
  activeConversationId: string | null;
}

/** Reads the health context sent with each message, as it is sent (US-15 AC10). */
export type ChatContextSource = () => ChatContextPayload | null;

interface UseChatStateOptions {
  isLoggedIn: boolean;
  guestInputs?: ChatContextSource;
  prefetchedData?: ChatPrefetchData | null;
  onRemoteConversationSelected?: () => void;
  /** Where the form edits the model proposes via tool_use go (pre-fill / med update). */
  onProposeEdit?: ChatEditTarget;
}

/** A reply's form edits (US-16): `ask` is told a question is sent; `take`
 *  gets the reply's edits with the erase the question was asked under, so they
 *  never land on a record erased since (US-16 AC2a). `leave`: the conversation
 *  switched (New chat, or a saved chat opened). */
export interface ChatEditTarget {
  ask: () => string;
  /** `stayed`: the chat the question was sent from (its local identity) is still shown. `refusals`: the parts
   *  refused as unreadable (US-67 AC2), their edits already left out. */
  take: (edits: ProposedEdit[], asked: string, stayed: boolean, refusals?: ChatEditRefusal[]) => void;
  leave: () => void;
}

const CUT_NOTICE = `Your message was cut at ${MAX_CHARS.toLocaleString('en')} characters.`;
const NO_PENDING: ChatPending = { thinking: '', text: '', status: '', sources: [] };
const SEND_FAILED = 'Something went wrong. Please try again.';

/** Enter sends, Shift+Enter is a new line, and an Enter that commits an input method's composition only commits it
 *  (US-15 AC26a): Chrome and Firefox mark it `isComposing`, Safari sends it just after with keyCode 229. */
export function sendsOnEnter(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

export function useChatState({ isLoggedIn, guestInputs, prefetchedData, onRemoteConversationSelected, onProposeEdit }: UseChatStateOptions) {
  const [instanceId] = useState(generateInstanceId);
  const [inputText, setInputText] = useState('');
  // A paste cut at MAX_CHARS (US-15 AC26): said in the error line until the box is next edited.
  const [cut, setCut] = useState(false);
  // A landed answer's thinking summary and articles read, by message id, for
  // this session only (AC17/AC22). Never persisted: not in `messages` (so not synced
  // to other tabs or written to the user's cloud chat history) and never sent to the server.
  const [approachById, setApproachById] = useState<Record<string, ChatApproach>>({});
  // US-59: subscription change cards, by assistant message id, this tab only
  // (like approachById: never persisted, synced or sent anywhere but the confirm).
  const [cardsById, setCardsById] = useState<Record<string, SubscriptionCardState>>({});
  const isOffline = useOffline();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // The box as typed, before the re-render (US-15 AC57): a failed send puts its question back only into an empty box.
  const inputTextRef = useRef(inputText);
  useEffect(() => { inputTextRef.current = inputText; }, [inputText]);

  // Other tabs' sends in flight (US-15 AC17c); this tab's own is the store's turn.
  const { othersBusy, othersBusyNow, ownEnded, onRemote } = useChatBusy();
  // The latest props and callbacks, read as each effect runs, never a render's that did not finish.
  const latest = useRef({ guestInputs, onProposeEdit, onRemoteConversationSelected, ownEnded });
  useLayoutEffect(() => { latest.current = { guestInputs, onProposeEdit, onRemoteConversationSelected, ownEnded }; });

  // Lists and loads keep today's guards until slice 3 deletes them. hasLoadedRef and isLoadingConvsRef
  // gate the list read before list-wanted; loadGenRef drops a thread's turns once a later read began.
  // The store's List and Load rule every landing either way: these refs guard nothing the store does not.
  const hasLoadedRef = useRef(!!prefetchedData);
  const isLoadingConvsRef = useRef(false);
  const loadGenRef = useRef(0);
  // Deltas collect here and reach the store at most once per animation frame (a render throttle only).
  const streamRef = useRef({ deltas: [] as ChatEvent[], frame: 0 });
  const [reads] = useState(() => new Set<() => void>());

  const [store] = useState(() => createChatStore(
    initialChatState({
      erase: getShownErase(), moving: 'none', // erase-state is wired in slice 4
      ...(prefetchedData ? { conversations: prefetchedData.conversations } : {}),
      ...(prefetchedData?.activeConversationId ? { opened: { id: prefetchedData.activeConversationId, messages: prefetchedData.messages } } : {}),
    }),
    // The first render's runner: it reads only refs, setters, the store and `latest`, so it never goes stale.
    (effect) => run(effect),
  ));
  const chat = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useLayoutEffect(() => joinChats(store), [store]);
  useEffect(() => () => { reads.forEach((stop) => stop()); cancelAnimationFrame(streamRef.current.frame); }, [reads]);

  /** This instance's chat state, to every other instance (US-15 AC17c names its fields). Only requests
   *  in flight are said to be busy, never a thread load here (N4); `isLoading`, for an older bundle, adds
   *  other tabs' so a post never ends their waits elsewhere (R4). `loaded`: whether `messages` are a history (R1). */
  const postState = () => {
    const s = store.getSnapshot();
    const sending = s.turn.phase !== 'idle';
    postSync({ instanceId, type: 'state', ts: Date.now(), payload: {
      conversations: s.conversations, activeConversationId: s.shown.id, messages: s.messages,
      isLoading: sending || othersBusyNow(), sending, loaded: s.load.phase === 'none', error: s.error,
    } });
  };

  const flushDeltas = () => {
    const stream = streamRef.current;
    cancelAnimationFrame(stream.frame);
    stream.frame = 0;
    const deltas = stream.deltas.splice(0);
    deltas.forEach((delta) => void store.dispatch(delta));
  };

  // Always send the plan as chat context: local-first (v2) means the server
  // has no health data for logged-in customers either (the v1 tables were
  // purged June 2026), so this is the only context the answer gets. Every
  // surface builds it with chatContextOf: the widget from its own state, the
  // blog bubble and the chatbot embed from the widget's saved copy. The
  // reader runs here, so each message carries what is saved now, even a save
  // made after the page loaded (US-15 AC10). None degrades to the empty context.
  // A throw before the request (reading the plan for context) is a failed
  // send like any other: the chat frees and the question goes back (US-15 AC17b).
  const request = async ({ turn, question, convId, history }: Extract<Effect, { type: 'request' }>) => {
    const onDelta = (delta: ChatDelta) => {
      const stream = streamRef.current;
      stream.deltas.push({ type: 'delta', turn, delta });
      if (!stream.frame) stream.frame = requestAnimationFrame(flushDeltas);
    };
    const p = latest.current;
    const { result, error } = await (async () => sendMessage(question, convId, p.guestInputs?.() ?? null, history, onDelta, Boolean(p.onProposeEdit)))()
      .catch(() => {
        // A fixed message: the thrown error can quote the saved plan, which holds health values.
        Sentry.captureMessage('Chat context read failed', { tags: { feature: 'chat' } });
        return { result: null, error: { error: SEND_FAILED } };
      });
    flushDeltas(); // the approach the reply keeps is everything streamed
    if (result && !error) await store.dispatch({ type: 'done', turn, result, now: new Date().toISOString() });
    else await store.dispatch({ type: 'failed', turn, message: error?.error ?? SEND_FAILED, boxEmpty: !inputTextRef.current });
  };

  const readList = async (read: number) => {
    isLoadingConvsRef.current = true;
    const result = await listConversations();
    isLoadingConvsRef.current = false;
    await store.dispatch({ type: 'list-landed', read, conversations: result?.conversations ?? null });
  };

  // N1/N2: every read ends in a landing for the load it began under; the store drops one that load has outlived.
  const readTurns = async (opening: number, id: string) => {
    const gen = ++loadGenRef.current;
    const turns = await readThread(store, opening, id, reads);
    if (turns === 'gone') await store.dispatch({ type: 'load-landed', opening, id, turns: null });
    else if (turns === 'failed') await store.dispatch({ type: 'load-failed', opening, id });
    else if (gen === loadGenRef.current) await store.dispatch({ type: 'load-landed', opening, id, turns });
  };

  const setCards = useCallback((next: Record<string, SubscriptionCardState>) => { cardsRef.current = next; setCardsById(next); }, []);

  /** Each effect through its door, in the order the store lists them. */
  function run(effect: Effect): Promise<void> | void {
    const p = latest.current;
    switch (effect.type) {
      case 'request': return request(effect);
      case 'read-list': return readList(effect.read);
      case 'read-turns': return readTurns(effect.opening, effect.id);
      case 'take-edits': return p.onProposeEdit?.take(effect.edits, effect.erase, effect.stayed, effect.refusals);
      case 'edits-ask': p.onProposeEdit?.ask(); return;
      case 'edits-leave': return p.onProposeEdit?.leave();
      case 'set-input': // the box is set now, before the re-render (US-15 AC57); other tabs mirror it
        inputTextRef.current = effect.text;
        setInputText(effect.text);
        setCut(false);
        return postInputSync(instanceId, effect.text);
      case 'focus-input': return inputRef.current?.focus();
      case 'keep-approach': return setApproachById((prev) => ({ ...prev, [effect.id]: effect.approach }));
      case 'add-card': return setCards({ ...cardsRef.current, [effect.id]: { card: effect.card as SubscriptionCard, phase: 'idle' } });
      case 'clear-extras': setApproachById({}); return setCards({});
      case 'remote-selected': return p.onRemoteConversationSelected?.();
      case 'post-state': return postState();
      case 'post-new': return postSync({ instanceId, type: 'thread-new', payload: {}, ts: Date.now() });
      case 'post-deleted': return postSync({ instanceId, type: 'thread-deleted', payload: { id: effect.id }, ts: Date.now() });
      case 'own-ended': return p.ownEnded();
    }
  }

  // BroadcastChannel subscription — sync state from other instances
  useEffect(() => subscribeSync((msg) => {
    if (msg.instanceId === instanceId) return;
    if (msg.type === 'input') {
      // Only mirror if this instance's input isn't focused (focus = authoritative)
      if (document.activeElement !== inputRef.current) setInputText(msg.payload.text);
      return;
    }
    if (msg.type === 'state') {
      void store.dispatch({ type: 'mirror-state', payload: msg.payload });
      // That tab's own send, tracked apart from this tab's (US-15 AC17c).
      onRemote(msg.instanceId, msg.payload.sending, msg.payload.isLoading);
      return;
    }
    if (msg.type === 'thread-new') void store.dispatch({ type: 'mirror-new' });
    else if (msg.type === 'thread-deleted') void store.dispatch({ type: 'thread-gone', id: msg.payload.id, tell: false });
  }), [instanceId, store, onRemote]);

  const loadConversationsIfNeeded = useCallback(async () => {
    if (hasLoadedRef.current || isLoadingConvsRef.current) return;
    hasLoadedRef.current = true;
    await store.dispatch({ type: 'list-wanted', guest: !isLoggedIn });
  }, [isLoggedIn, store]);

  const selectConversation = useCallback((id: string) => store.dispatch({ type: 'open-thread', id }), [store]);
  /** Try again: open the thread whose read failed once more (N2). */
  const retryLoad = useCallback(() => {
    const { load } = store.getSnapshot();
    if (load.phase === 'failed') void store.dispatch({ type: 'open-thread', id: load.id });
  }, [store]);
  const startNewChat = useCallback(() => { void store.dispatch({ type: 'new-chat' }); }, [store]);

  // The box and the other tabs are read now: a second press before the re-render sends nothing.
  const handleSend = useCallback(() => store.dispatch({
    type: 'send', text: inputTextRef.current, online: !isOffline, othersBusy: othersBusyNow(),
    now: new Date().toISOString(), nonce: crypto.randomUUID(),
  }), [store, isOffline, othersBusyNow]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (await deleteConversation(id)) await store.dispatch({ type: 'thread-gone', id, tell: true });
  }, [store]);

  /** The customer pressed Confirm (US-59): the one request that makes the change. */
  const cardsRef = useRef(cardsById);
  useEffect(() => { cardsRef.current = cardsById; }, [cardsById]);
  const confirmSubscription = useCallback(async (messageId: string) => {
    const entry = cardsRef.current[messageId];
    // The ref flips to 'sending' synchronously, so a double click sends once.
    if (!entry || entry.phase !== 'idle') return;
    setCards({ ...cardsRef.current, [messageId]: { ...entry, phase: 'sending' } });
    const result = await confirmSubscriptionChange(entry.card);
    // The usage signal is counted by the server's confirm route (US-59), on every bundle.
    // 'busy' leaves the card open to try again; every other outcome closes it.
    setCards({ ...cardsRef.current, [messageId]: { ...entry, result, phase: result.code === 'busy' ? 'idle' : 'closed' } });
  }, [setCards]);

  const dismissSubscription = useCallback((messageId: string) => {
    const entry = cardsRef.current[messageId];
    if (entry?.phase === 'idle') setCards({ ...cardsRef.current, [messageId]: { ...entry, phase: 'closed', dismissed: true } });
  }, [setCards]);

  const handleInputChange = useCallback((text: string) => {
    const sliced = cutText(text, MAX_CHARS);
    // Say so when a paste is cut (US-15 AC26); the next edit within the cap clears it.
    setCut(text.length > MAX_CHARS);
    inputTextRef.current = sliced;
    setInputText(sliced);
    postInputSync(instanceId, sliced);
  }, [instanceId]);

  return {
    state: {
      conversations: chat.conversations,
      activeConversationId: chat.shown.id,
      messages: chat.messages,
      inputText,
      // Send and the box are locked while any request is open or the shown thread is not read (busy).
      isLoading: busy(chat, othersBusy),
      // The dots or the streamed reply: this tab's reply only under the chat that asked; another tab's as before (US-15 AC7a, R7 b).
      replying: isLocalSender(chat) || othersBusy,
      isLocalSender: isLocalSender(chat),
      load: chat.load.phase,
      // Words beside a Send this tab's own request locks (R3): one an erase emptied, or one for a chat not on screen.
      wait: chat.turn.phase === 'orphaned' ? 'orphaned' as const : chat.turn.phase !== 'idle' && chat.turn.asked.key !== chat.shown.key ? 'other-chat' as const : null,
      error: cut ? CUT_NOTICE : chat.error,
      pending: showsPending(chat) ?? NO_PENDING,
      approachById,
      cardsById,
      isOffline,
    },
    actions: {
      confirmSubscription,
      dismissSubscription,
      handleInputChange,
      selectConversation,
      retryLoad,
      startNewChat,
      handleSend,
      handleDelete,
      loadConversationsIfNeeded,
    },
    refs: { inputRef, messagesContainerRef },
  };
}
