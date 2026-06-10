/**
 * Shared mechanics for the standalone's native <dialog> lightboxes (backend
 * picker, history). showModal() on mount = top-layer + real focus trap +
 * native Escape + focus restore; plus the <html> scroll lock (the page
 * scrolls on <html>, so body alone doesn't stop it in Chrome).
 */
import { useEffect, useRef } from 'react';

export function useModalDialog(): React.RefObject<HTMLDialogElement> {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prevOverflow;
    };
  }, []);
  return dialogRef;
}
