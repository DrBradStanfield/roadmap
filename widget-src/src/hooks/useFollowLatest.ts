/** Following the latest chat message, shared by ChatSection (bubble) and ChatEmbed (inline panel). */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How far above the bottom of a chat's messages still counts as reading the latest one. */
const NEAR_BOTTOM_PX = 100;
const distanceFromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
const nearBottom = (el: HTMLElement) => distanceFromBottom(el) < NEAR_BOTTOM_PX;

/** Keeps a chat's messages at the latest one while the reader is there, and says when to show the
 *  jump-to-latest button (US-15 AC55). Where the reader is gets read on each scroll and after each
 *  change, so it is known before the next message lands. Read after, a long new message (a pasted
 *  report) looks like the reader scrolled away. A reading belongs to one list element and to the
 *  conversation whose messages were on screen when it was taken: the active id at the moment the
 *  `messages` array last changed, so an id that changes before its messages arrive (opening a
 *  conversation from History, even mid-reply) files nothing under it. A list element is read when it
 *  mounts. Until there is a reading for the messages now shown (once another conversation's messages
 *  are in the same list: the panel's History drawer, New Chat, a choice made in another tab), the
 *  list is read as it stands, as before. */
export function useFollowLatest(
  ref: React.RefObject<HTMLElement | null>,
  conversation: unknown,
  messages: unknown,
  changes: readonly unknown[],
) {
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const reader = useRef<{ el: HTMLElement | null; conversation: unknown; atBottom: boolean }>({ el: null, conversation: undefined, atBottom: false });
  const onScreen = useRef({ messages, conversation });
  if (onScreen.current.messages !== messages) onScreen.current = { messages, conversation };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const shown = onScreen.current.conversation;
    const known = reader.current.el === el && reader.current.conversation === shown;
    const atBottom = known ? reader.current.atBottom : nearBottom(el);
    if (atBottom) el.scrollTop = el.scrollHeight;
    reader.current = { el, conversation: shown, atBottom };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `changes` is the caller's dependency list
  }, [ref, messages, ...changes]);
  // A list mounted with nothing else changed (the bubble's History, then Back) is read as it mounts,
  // before the next message can grow it. Runs after every render; it only acts on a new element.
  useEffect(() => {
    const el = ref.current;
    if (el && reader.current.el !== el) reader.current = { el, conversation: onScreen.current.conversation, atBottom: nearBottom(el) };
  });
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const distance = distanceFromBottom(el);
    reader.current = { el, conversation: onScreen.current.conversation, atBottom: distance < NEAR_BOTTOM_PX };
    setShowScrollBtn(distance > NEAR_BOTTOM_PX); // React skips the render when the value is unchanged
  }, [ref]);
  return { showScrollBtn, onScroll };
}
