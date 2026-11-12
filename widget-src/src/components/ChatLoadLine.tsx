/**
 * The shown thread's read, in words (N1, N2): Send is disabled while it loads
 * or after it failed, so a disabled Send always has a line beside it. A failed
 * read is never shown as an empty thread; Try again reads it once more.
 */
export function ChatLoadLine({ load, onRetry, onNew }: { load: 'none' | 'loading' | 'failed'; onRetry: () => void; onNew: () => void }) {
  if (load === 'loading') return <p className="chat-load-line" role="status">Loading conversation…</p>;
  if (load !== 'failed') return null;
  return (
    <div className="chat-load-line" role="alert">
      <p>Couldn't open this conversation.</p>
      <div className="chat-load-actions">
        <button type="button" className="chat-new-btn" onClick={onRetry}>Try again</button>
        <button type="button" className="chat-new-btn" onClick={onNew}>+ New Chat</button>
      </div>
    </div>
  );
}
