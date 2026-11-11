/**
 * The chat reply as it streams in (US-15 AC16, AC17, AC20, AC38), on the
 * sending instance only; other tabs show the dots. Split from useChatState
 * (file budget).
 */
import { useCallback, useRef, useState } from 'react';
import type { ChatApproach, ChatDelta, ChatPending } from '../lib/chat-api';

export const NO_PENDING: ChatPending = { thinking: '', text: '', status: '', sources: [] };

export function useChatStream() {
  const [pending, setPending] = useState(NO_PENDING);
  const streamRef = useRef({ ...NO_PENDING, frame: 0 });

  // Deltas collect in a ref and render at most once per animation frame.
  // A status line starts a new phase: text streamed before it was not the
  // answer (a run_roadmap round's preamble, US-15 AC38), so it is cleared.
  const handleDelta = useCallback((delta: ChatDelta) => {
    const stream = streamRef.current;
    if (delta.type === 'sources') stream.sources = delta.titles;
    else if (delta.type === 'status') { stream.status = delta.text; stream.text = ''; }
    else stream[delta.type] += delta.text;
    if (stream.frame) return;
    stream.frame = requestAnimationFrame(() => {
      stream.frame = 0;
      setPending({ thinking: stream.thinking, text: stream.text, status: stream.status, sources: stream.sources });
    });
  }, []);

  /** Ends the stream; returns the thinking summary and the articles read it collected. */
  const endStream = useCallback((): ChatApproach => {
    const stream = streamRef.current;
    cancelAnimationFrame(stream.frame);
    const { thinking, sources } = stream;
    streamRef.current = { ...NO_PENDING, frame: 0 };
    setPending(NO_PENDING);
    return { thinking, sources };
  }, []);

  return { pending, handleDelta, endStream };
}
