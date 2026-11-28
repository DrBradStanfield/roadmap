/**
 * Shared mechanics for the native <dialog> lightboxes (the standalone's backend
 * picker and history, and the document viewer, US-14 AC7a). showModal() on
 * mount = top-layer + real focus trap + native Escape; plus the <html> scroll
 * lock (the page scrolls on <html>, so body alone doesn't stop it in Chrome). Closing unmounts the dialog, and a
 * removed dialog gives the focus back to nothing (only close() does), so the
 * cleanup returns it to whatever had it when the dialog opened (US-09 AC34).
 * In src/lib, not standalone/, because src must never import standalone.
 */
import { useEffect, useRef, useState } from 'react';

export function useModalDialog(): React.RefObject<HTMLDialogElement> {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Read on the first render, before showModal() moves the focus inside. Never
  // null: the page has a body (every caller portals into it).
  const [opener] = useState(() => document.activeElement as HTMLElement);
  useEffect(() => {
    dialogRef.current?.showModal();
    // A dialog's own first focus, where it names one: its title, so a tap draws no ring on a button.
    dialogRef.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    // The host page's own values, each kept: `overflow` reads '' when only one of them is set (US-14 AC7a).
    const html = document.documentElement.style;
    const prior = [html.overflowX, html.overflowY];
    html.overflowX = html.overflowY = 'hidden';
    return () => {
      [html.overflowX, html.overflowY] = prior;
      opener.focus();
    };
  }, [opener]);
  return dialogRef;
}
