/**
 * History lightbox host (standalone only). The widget's "View history" links
 * fire `hr:open-history` via the shim's openHistoryLightbox override (Brad's
 * call 2026-06-11: lightbox, not a separate page — /pages/health-history
 * doesn't exist off-Shopify). Native <dialog> like the backend picker.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HistoryPanel } from '../src/components/HistoryPanel';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

export function HistoryLightboxHost() {
  const [openMetric, setOpenMetric] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpenMetric((e as CustomEvent<{ metric: string | null }>).detail?.metric ?? null);
    };
    window.addEventListener('hr:open-history', onOpen);
    return () => window.removeEventListener('hr:open-history', onOpen);
  }, []);

  if (openMetric === undefined) return null;
  return <HistoryDialog metric={openMetric} onClose={() => setOpenMetric(undefined)} />;
}

function HistoryDialog({ metric, onClose }: { metric: string | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    dialogRef.current?.showModal();
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prevOverflow;
    };
  }, []);

  return createPortal(
    <dialog
      className="hr-modal hr-modal--wide"
      aria-label="Your health history"
      ref={dialogRef}
      onCancel={(e) => { e.preventDefault(); onCloseRef.current(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onCloseRef.current(); }}
    >
      <div className="hr-modal-inner">
        <button className="hr-modal-close" aria-label="Close" onClick={onClose}>×</button>
        <ErrorBoundary>
          <HistoryPanel isLoggedIn initialMetric={metric ?? undefined} />
        </ErrorBoundary>
      </div>
    </dialog>,
    document.body,
  );
}
