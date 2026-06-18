/**
 * Site-wide chat bubble — IIFE entry point.
 *
 * Loaded on all pages via chat-embed.liquid (app embed block).
 * Skips the roadmap page where HealthTool handles its own chat.
 * Reads guest health data from localStorage (entered on roadmap page).
 * Logged-in users get full personalization from Supabase (server-side).
 */
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatSection } from './components/ChatSection';
import { ErrorBoundary } from './components/ErrorBoundary';
import { loadGuestInputs } from './lib/storage';
import { initSentry } from './lib/sentry';
import './styles.css';

initSentry();

// Gap (px) to leave between the FAB and the footer's top edge when docked.
const FAB_FOOTER_GAP = 16;
// Resting offset (px) from the bottom of the viewport — matches the CSS default.
const FAB_BASE_BOTTOM = 24;

/**
 * Keep the floating FAB from overlapping the page footer.
 *
 * When the footer scrolls into view, lift the FAB so it sits just above the
 * footer's top edge; when the footer leaves the viewport, drop it back to its
 * resting position. Theme-agnostic and no-ops gracefully when there is no
 * footer (some themes), so this stays safe as shared extension code.
 *
 * Implemented by animating the FAB's `bottom` via a CSS custom property
 * (`--chat-fab-bottom`) — deliberately NOT `transform`, which the `.chat-fab`
 * already uses for its hover scale / entrance animation.
 */
function useFooterDock(fabRef: React.RefObject<HTMLButtonElement>) {
  useEffect(() => {
    const fab = fabRef.current;
    if (!fab) return;

    const footer =
      document.querySelector<HTMLElement>('footer') ||
      document.querySelector<HTMLElement>('.shopify-section-group-footer-group');
    // No footer on this theme/page — leave the FAB at its resting position.
    if (!footer) return;

    let frame = 0;
    const reposition = () => {
      frame = 0;
      const rect = footer.getBoundingClientRect();
      // How far the footer's top edge sits above the viewport bottom.
      const overlap = window.innerHeight - rect.top;
      if (overlap > FAB_BASE_BOTTOM) {
        fab.style.setProperty(
          '--chat-fab-bottom',
          `${Math.round(overlap + FAB_FOOTER_GAP)}px`,
        );
        fab.classList.add('chat-fab-docked');
      } else {
        fab.style.removeProperty('--chat-fab-bottom');
        fab.classList.remove('chat-fab-docked');
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(reposition);
    };

    // Scroll listening uses the document in the CAPTURE phase: scroll events
    // don't bubble, but they DO travel down the capture phase, so this catches
    // scrolling on ANY container — including themes (e.g. Shopify Horizon) that
    // make <html>/<body> overflow:hidden and scroll an inner wrapper div, where
    // a plain window 'scroll' listener never fires.
    let listening = false;
    const startListening = () => {
      if (listening) return;
      listening = true;
      document.addEventListener('scroll', schedule, { passive: true, capture: true });
      window.addEventListener('resize', schedule, { passive: true });
    };
    const stopListening = () => {
      if (!listening) return;
      listening = false;
      document.removeEventListener('scroll', schedule, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', schedule);
    };

    // IntersectionObserver tells us *when* the footer enters/leaves the
    // viewport; while it's intersecting we track its exact position on scroll.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) startListening();
        else stopListening();
        schedule();
      },
      { threshold: 0 },
    );
    observer.observe(footer);

    return () => {
      observer.disconnect();
      stopListening();
      if (frame) cancelAnimationFrame(frame);
      fab.style.removeProperty('--chat-fab-bottom');
      fab.classList.remove('chat-fab-docked');
    };
  }, [fabRef]);
}

interface ChatBubbleProps {
  isLoggedIn: boolean;
  fabLabel: string;
  guestInputs: Record<string, unknown> | null;
}

function ChatBubble({ isLoggedIn, fabLabel, guestInputs }: ChatBubbleProps) {
  const [open, setOpen] = useState(false);
  const [widgetChatOpen, setWidgetChatOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);

  // Dock the FAB above the footer when the footer scrolls into view.
  useFooterDock(fabRef);

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
      ref={fabRef}
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
    : 'Need help? Ask here';

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
