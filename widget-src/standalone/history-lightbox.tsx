/**
 * History lightbox host (standalone only). The widget's "View history" links
 * fire `hr:open-history` via the shim's openHistoryLightbox override (Brad's
 * call 2026-06-11: lightbox, not a separate page — /pages/health-history
 * doesn't exist off-Shopify). Native <dialog> like the backend picker.
 *
 * The host (this tiny listener) mounts eagerly; HistoryPanel — which drags the
 * chart library with it — lazy-loads on first open so the main bundle stays
 * light.
 */
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { useModalDialog } from './use-dialog';

const HistoryPanel = React.lazy(() =>
  import('../src/components/HistoryPanel').then((m) => ({ default: m.HistoryPanel })),
);

export function HistoryLightboxHost() {
  const [isOpen, setIsOpen] = useState(false);
  const [metric, setMetric] = useState<string | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      setMetric((e as CustomEvent<{ metric: string | null }>).detail?.metric ?? null);
      setIsOpen(true);
    };
    window.addEventListener('hr:open-history', onOpen);
    return () => window.removeEventListener('hr:open-history', onOpen);
  }, []);

  if (!isOpen) return null;
  return <HistoryDialog metric={metric} onClose={() => setIsOpen(false)} />;
}

function HistoryDialog({ metric, onClose }: { metric: string | null; onClose: () => void }) {
  const dialogRef = useModalDialog();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
          <Suspense fallback={<p style={{ padding: 24 }}>Loading your history…</p>}>
            <HistoryPanel isLoggedIn initialMetric={metric ?? undefined} />
          </Suspense>
        </ErrorBoundary>
      </div>
    </dialog>,
    document.body,
  );
}
