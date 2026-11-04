/**
 * Shared mechanics for the standalone's native <dialog> lightboxes (backend
 * picker, history). showModal() on mount = top-layer + real focus trap +
 * native Escape; plus the <html> scroll lock (the page scrolls on <html>, so
 * body alone doesn't stop it in Chrome). Closing unmounts the dialog, and a
 * removed dialog gives the focus back to nothing (only close() does), so the
 * cleanup returns it to whatever had it when the dialog opened (US-09 AC34).
 */
import { useEffect, useRef, useState } from 'react';

export function useModalDialog(): React.RefObject<HTMLDialogElement> {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Read on the first render, before showModal() moves the focus inside. Never
  // null: the page has a body (both dialogs portal into it).
  const [opener] = useState(() => document.activeElement as HTMLElement);
  useEffect(() => {
    dialogRef.current?.showModal();
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prevOverflow;
      opener.focus();
    };
  }, [opener]);
  return dialogRef;
}
