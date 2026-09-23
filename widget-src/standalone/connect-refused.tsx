/**
 * A connect refused on this page load (US-09 AC15). Said ABOVE the widget, as
 * the reminders notice is: every connect path reloads onto slide 1, and a line
 * inside the plan panel would be announced to an off-screen slide. "Try again"
 * is the same picker the user connected from.
 */
import { useState } from 'react';
import { openBackendPicker } from '../src/lib/storage-notice';

export function ConnectRefusedNotice({ message }: { message: string }) {
  const [shown, setShown] = useState(true);
  if (!shown) return null;
  return (
    <div className="hr-sync hr-page-notice" role="alert">
      <span className="hr-sync-status">{message}</span>
      <button type="button" className="hr-sync-btn" onClick={openBackendPicker}>Try again</button>
      <button type="button" className="hr-sync-link hr-page-notice-dismiss" onClick={() => setShown(false)}>
        Dismiss
      </button>
    </div>
  );
}
