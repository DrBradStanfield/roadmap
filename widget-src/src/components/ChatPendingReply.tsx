import { ChatMessageBubble } from './ChatMessageBubble';
import type { ChatPending } from '../lib/chat-api';

/**
 * The reply while it is being written (US-15 AC16/AC17/AC20). The sending
 * instance shows the server's progress line and the articles it loaded, the
 * model's thinking summary live, then the answer filling in; other tabs,
 * which get no deltas, show the pulsing dots.
 */
export function ChatPendingReply({ isLocalSender, pending: { thinking, text, status, sources } }: { isLocalSender: boolean; pending: ChatPending }) {
  if (!isLocalSender) {
    return (
      <div className="chat-message chat-message--assistant">
        <div className="chat-loading"><span className="chat-thinking-dots" /></div>
      </div>
    );
  }
  // The live region is a short static line: a screen reader hears the phase,
  // not every word of the growing summary. The status is a fixed server string.
  const phase = status ? `${status}…` : 'Thinking…';
  const reading = sources.length > 0 && <p className="chat-sources">Reading: {sources.join(' · ')}</p>;
  return (
    <>
      <p className="chat-pending-status" aria-live="polite">{text ? 'Answering…' : phase}</p>
      {thinking || !text ? (
        <div className="chat-message chat-message--assistant">
          <div className="chat-loading chat-thinking-panel">
            {/* "Draft notes" only once there are notes: a path that never streams shows "Thinking…". */}
            <span className="chat-thinking-label">{thinking ? 'Thinking (draft notes, not the answer)' : phase}</span>
            {reading}
            {thinking && <p className="chat-thinking-summary">{thinking}</p>}
          </div>
        </div>
      ) : reading /* no summary: the panel went when text started; the line stays above the answer (AC21) */}
      {text && <ChatMessageBubble msg={{ id: 'streaming', role: 'assistant', content: text, createdAt: '' }} />}
    </>
  );
}
