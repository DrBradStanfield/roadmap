/**
 * Site-wide chat bubble — IIFE entry point.
 *
 * Loaded on all pages via chat-embed.liquid (app embed block).
 * Skips the roadmap page where HealthTool handles its own chat.
 * Reads guest health data from localStorage (entered on roadmap page).
 * Logged-in users get full personalization from Supabase (server-side).
 */
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatSection } from './components/ChatSection';
import { ErrorBoundary } from './components/ErrorBoundary';
import { loadGuestInputs } from './lib/storage';
import { initSentry } from './lib/sentry';
import './styles.css';

initSentry();

interface ChatBubbleProps {
  isLoggedIn: boolean;
  fabLabel: string;
  guestInputs: Record<string, unknown> | null;
}

function ChatBubble({ isLoggedIn, fabLabel, guestInputs }: ChatBubbleProps) {
  const [open, setOpen] = useState(false);
  const [widgetChatOpen, setWidgetChatOpen] = useState(false);

  // Hide FAB when the widget's embedded chat is expanded — but only when the
  // dedicated embed block is NOT present. When the embed is on the page, all
  // three UIs (inline, FAB, embed) coexist intentionally and stay in sync.
  useEffect(() => {
    if (document.getElementById('health-chatbot-embed-root')) return;
    const widgetRoot = document.getElementById('health-tool-root');
    if (!widgetRoot) return;

    const check = () => setWidgetChatOpen(!!widgetRoot.querySelector('.chat-expanded'));
    check();

    const observer = new MutationObserver(check);
    observer.observe(widgetRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  if (open) {
    return (
      <ChatSection
        isLoggedIn={isLoggedIn}
        startExpanded
        onClose={() => setOpen(false)}
        guestInputs={guestInputs}
      />
    );
  }

  if (widgetChatOpen) return null;

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
  const productTitle = container.dataset.productTitle;

  const fabLabel = productTitle
    ? `Questions about ${productTitle}?`
    : 'Ask about your health';

  const guestInputs = isLoggedIn ? null : loadGuestInputs();

  container.style.display = '';
  const root = createRoot(container);
  root.render(
    <ErrorBoundary>
      <ChatBubble
        isLoggedIn={isLoggedIn}
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
