/**
 * Site-wide chat bubble — IIFE entry point.
 *
 * Loaded on all pages via chat-embed.liquid (app embed block).
 * Skips the roadmap page where HealthTool handles its own chat.
 * Reads guest health data from localStorage (entered on roadmap page).
 * Logged-in users get full personalization from Supabase (server-side).
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatSection } from './components/ChatSection';
import { ErrorBoundary } from './components/ErrorBoundary';
import { loadFromLocalStorage } from './lib/storage';
import { initSentry } from './lib/sentry';
import './styles.css';

initSentry();

interface ChatBubbleProps {
  isLoggedIn: boolean;
  loginUrl?: string;
  fabLabel: string;
  guestInputs: Record<string, unknown> | null;
}

function ChatBubble({ isLoggedIn, loginUrl, fabLabel, guestInputs }: ChatBubbleProps) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <ChatSection
        isLoggedIn={isLoggedIn}
        loginUrl={loginUrl}
        startExpanded
        onClose={() => setOpen(false)}
        guestInputs={guestInputs}
      />
    );
  }

  return (
    <button
      className="chat-fab no-print"
      onClick={() => setOpen(true)}
      aria-label="Open chat"
    >
      <span className="chat-fab-icon">💬</span>
      <span className="chat-fab-label">{fabLabel}</span>
    </button>
  );
}

function mount() {
  const container = document.getElementById('health-chat-root');
  if (!container) return;

  const isLoggedIn = container.dataset.loggedIn === 'true';
  const loginUrl = container.dataset.loginUrl || undefined;
  const productTitle = container.dataset.productTitle;

  const fabLabel = productTitle
    ? `Questions about ${productTitle}?`
    : 'Ask about your health';

  // Guest health data from localStorage (entered on roadmap page, available everywhere)
  let guestInputs: Record<string, unknown> | null = null;
  if (!isLoggedIn) {
    const cached = loadFromLocalStorage();
    if (cached && Object.keys(cached.inputs).length > 0) {
      guestInputs = {
        ...cached.inputs,
        medications: cached.medications ?? [],
        screenings: cached.screenings ?? [],
      };
    }
  }

  container.style.display = '';
  const root = createRoot(container);
  root.render(
    <ErrorBoundary>
      <ChatBubble
        isLoggedIn={isLoggedIn}
        loginUrl={loginUrl}
        fabLabel={fabLabel}
        guestInputs={guestInputs}
      />
    </ErrorBoundary>,
  );
}

// Mount when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
