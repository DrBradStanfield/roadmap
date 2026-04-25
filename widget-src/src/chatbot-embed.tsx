/**
 * Embedded chatbot widget — IIFE entry point.
 * Mounted as a section block (target: "section") anywhere on the storefront.
 * Syncs live with the FAB and inline ChatSection via BroadcastChannel.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatEmbed } from './components/ChatEmbed';
import { ErrorBoundary } from './components/ErrorBoundary';
import { loadFromLocalStorage, loadGuestInputs } from './lib/storage';
import { initSentry } from './lib/sentry';
import { computeFormStage } from '@roadmap/health-core';
import './styles.css';

initSentry();

function readFormStage(): 1 | 2 | 3 {
  const data = loadFromLocalStorage();
  return data ? computeFormStage(data.inputs) : 1;
}

function ChatEmbedRoot({ isLoggedIn, guestInputs }: { isLoggedIn: boolean; guestInputs: Record<string, unknown> | null }) {
  const [formStage, setFormStage] = useState<1 | 2 | 3>(() => readFormStage());

  useEffect(() => {
    const recompute = () => {
      const next = readFormStage();
      setFormStage(prev => prev === next ? prev : next);
    };
    window.addEventListener('storage', recompute);
    window.addEventListener('hr:inputs-changed', recompute);
    return () => {
      window.removeEventListener('storage', recompute);
      window.removeEventListener('hr:inputs-changed', recompute);
    };
  }, []);

  return <ChatEmbed isLoggedIn={isLoggedIn} guestInputs={guestInputs} muted={formStage < 3} />;
}

function mount() {
  const container = document.getElementById('health-chatbot-embed-root');
  if (!container) return;

  const isLoggedIn = container.dataset.loggedIn === 'true';

  const guestInputs = isLoggedIn ? null : loadGuestInputs();

  const root = createRoot(container);
  root.render(
    <ErrorBoundary>
      <ChatEmbedRoot isLoggedIn={isLoggedIn} guestInputs={guestInputs} />
    </ErrorBoundary>,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
