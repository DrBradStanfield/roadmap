/**
 * Embedded chatbot widget — IIFE entry point.
 * Mounted as a section block (target: "section") anywhere on the storefront.
 * Syncs live with the FAB and inline ChatSection via BroadcastChannel.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatEmbed } from './components/ChatEmbed';
import { ErrorBoundary } from './components/ErrorBoundary';
import { computeFormStage } from '@roadmap/health-core';
import { loadFromLocalStorage, loadGuestInputs, MIRROR_CHANGED_EVENT, MIRROR_KEY } from './lib/storage';
import { resolveAssistantName, setAssistantName } from './lib/assistant-config';
import { initSentry } from './lib/sentry';
import './styles.css';

initSentry();

function readFormStage(): 1 | 2 | 3 {
  const cached = loadFromLocalStorage();
  return cached ? computeFormStage(cached.inputs, cached.previousMeasurements) : 1;
}

function ChatEmbedRoot({ isLoggedIn }: { isLoggedIn: boolean }) {
  const [formStage, setFormStage] = useState<1 | 2 | 3>(() => readFormStage());

  useEffect(() => {
    const recompute = () => {
      const next = readFormStage();
      setFormStage(prev => prev === next ? prev : next);
    };
    // Another tab's write to the mirror; a null key is a clear of all storage.
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key !== MIRROR_KEY) return;
      recompute();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(MIRROR_CHANGED_EVENT, recompute);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(MIRROR_CHANGED_EVENT, recompute);
    };
  }, []);

  // The chat context, read as each message is sent: see useChatState.
  return <ChatEmbed isLoggedIn={isLoggedIn} guestInputs={loadGuestInputs} muted={formStage < 3} />;
}

function mount() {
  const container = document.getElementById('health-chatbot-embed-root');
  if (!container) return;

  setAssistantName(resolveAssistantName(container));

  const isLoggedIn = container.dataset.loggedIn === 'true';

  const root = createRoot(container);
  root.render(
    <ErrorBoundary>
      <ChatEmbedRoot isLoggedIn={isLoggedIn} />
    </ErrorBoundary>,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
