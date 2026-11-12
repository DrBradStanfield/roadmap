/** This tab's request is open for a chat no longer on screen (PR 1359 R3). */
export const WAITING_LINE = 'Waiting for your other reply…';
/** An erase emptied the chat while its request is still open (PR 1359 R3, Fable 2026-11-12). */
export const ORPHANED_LINE = 'Your chat was erased. You can ask again in a moment.';

/**
 * Words beside a locked Send, each derived from the chat's state: the shown
 * thread loading or failed to read (N1, N2; Try again reads it once more, so a
 * failed read never shows as an empty thread), or this tab's request open for
 * a chat not on screen or one an erase emptied (`wait`). Another tab's request
 * shows its dots instead (ChatPendingReply).
 */
export function ChatLoadLine({ load, wait, onRetry, onNew }: {
  load: 'none' | 'loading' | 'failed'; wait: 'other-chat' | 'orphaned' | null; onRetry: () => void; onNew: () => void;
}) {
  const waitLine = wait ? <p className="chat-load-line" role="status">{wait === 'orphaned' ? ORPHANED_LINE : WAITING_LINE}</p> : null;
  if (load === 'loading') return <>{waitLine}<p className="chat-load-line" role="status">Loading conversation…</p></>;
  if (load !== 'failed') return waitLine;
  return (
    <>
      {waitLine}
      <div className="chat-load-line" role="alert">
        <p>Couldn't open this conversation.</p>
        <div className="chat-load-actions">
          <button type="button" className="chat-new-btn" onClick={onRetry}>Try again</button>
          <button type="button" className="chat-new-btn" onClick={onNew}>+ New Chat</button>
        </div>
      </div>
    </>
  );
}
