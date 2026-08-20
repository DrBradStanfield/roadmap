/**
 * Site-wide chat bubble — IIFE entry point.
 *
 * Loaded on all pages via chat-embed.liquid (app embed block).
 * Skips the roadmap page where HealthTool handles its own chat.
 * Reads cached health data from localStorage (entered on roadmap page) and
 * sends it as chat context — local-first, the server holds no health data.
 */
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatSection } from './components/ChatSection';
import { ErrorBoundary } from './components/ErrorBoundary';
import { loadGuestInputs } from './lib/storage';
import { observeVisibility } from './lib/observe-visibility';
import { resolveAssistantName, setAssistantName } from './lib/assistant-config';
import { initSentry } from './lib/sentry';
import './styles.css';

initSentry();

// Gap (px) to leave between the FAB and the footer's top edge when docked.
const FAB_FOOTER_GAP = 16;
// Gap (px) between the FAB and the top of the theme's sticky add-to-cart bar.
const FAB_STICKY_ATC_GAP = 12;
// Resting offset (px) from the bottom of the viewport — matches the CSS default.
const FAB_BASE_BOTTOM = 24;

/**
 * Keep the floating FAB clear of page furniture pinned to the bottom of the
 * viewport: the page footer (when it scrolls into view) and the theme's
 * sticky add-to-cart bar (`#md-sticky-atc`, shown on product pages once the
 * visitor scrolls past the main product form — without a lift the FAB sits
 * directly on its Add-to-cart button). The FAB's `bottom` becomes the largest
 * clearance any obstacle needs; each part no-ops when its element is missing,
 * so this stays safe as shared extension code across themes/stores.
 *
 * Implemented by animating the FAB's `bottom` via a CSS custom property
 * (`--chat-fab-bottom`) — deliberately NOT `transform`, which the `.chat-fab`
 * already uses for its hover scale / entrance animation.
 *
 * Takes the FAB element (from a callback ref), not a ref object: the button
 * unmounts while the chat panel is open and remounts as a NEW node on close,
 * so the effect must re-bind — and immediately re-position — per element.
 */
function useFabLift(fab: HTMLButtonElement | null) {
  useEffect(() => {
    if (!fab) return;

    const footer =
      document.querySelector<HTMLElement>('footer') ||
      document.querySelector<HTMLElement>('.shopify-section-group-footer-group');
    const stickyAtc = document.getElementById('md-sticky-atc');
    // No bottom-pinned obstacles on this page — leave the FAB at rest.
    if (!footer && !stickyAtc) return;

    let frame = 0;
    const reposition = () => {
      frame = 0;
      let bottom = FAB_BASE_BOTTOM;
      if (footer) {
        // How far the footer's top edge sits above the viewport bottom.
        const overlap = window.innerHeight - footer.getBoundingClientRect().top;
        if (overlap > FAB_BASE_BOTTOM) {
          bottom = Math.max(bottom, overlap + FAB_FOOTER_GAP);
        }
      }
      if (stickyAtc && stickyAtc.classList.contains('show')) {
        // offsetHeight: layout height, unaffected by the bar's slide-in transform.
        bottom = Math.max(bottom, stickyAtc.offsetHeight + FAB_STICKY_ATC_GAP);
      }
      if (bottom > FAB_BASE_BOTTOM) {
        fab.style.setProperty('--chat-fab-bottom', `${Math.round(bottom)}px`);
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

    // observeVisibility tells us *when* the footer enters/leaves the
    // viewport; while it's intersecting we track its exact position on scroll.
    // (Where IntersectionObserver is missing — Lockdown Mode — it degrades to
    // always-listening, which is just the pre-optimization behaviour.)
    let stopObserving = () => {};
    if (footer) {
      stopObserving = observeVisibility(footer, (visible) => {
        if (visible) startListening();
        else stopListening();
        schedule();
      }, { threshold: 0 });
    }

    // Sticky-bar tracking: the bar toggles a `show` class from its own scroll
    // listener, so a class MutationObserver (rAF-coalesced by `schedule`) is
    // enough — no extra scroll listener needed. The resize handler is a
    // DISTINCT function from `schedule`: the footer path's stopListening()
    // removes `schedule` from window resize, and sharing the reference would
    // silently detach this permanent listener too.
    let barObserver: MutationObserver | null = null;
    const onWindowResize = () => schedule();
    if (stickyAtc) {
      barObserver = new MutationObserver(schedule);
      barObserver.observe(stickyAtc, { attributes: true, attributeFilter: ['class'] });
      // Bar height varies by breakpoint, so track resizes for its lift too.
      window.addEventListener('resize', onWindowResize, { passive: true });
    }

    // Position immediately: on a remount (chat closed) the obstacles may
    // already be on screen and no observer callback is coming.
    schedule();

    return () => {
      stopObserving();
      stopListening();
      if (barObserver) barObserver.disconnect();
      if (stickyAtc) window.removeEventListener('resize', onWindowResize);
      if (frame) cancelAnimationFrame(frame);
      fab.style.removeProperty('--chat-fab-bottom');
      fab.classList.remove('chat-fab-docked');
    };
  }, [fab]);
}

interface ChatBubbleProps {
  isLoggedIn: boolean;
  fabLabel: string;
  guestInputs: Record<string, unknown> | null;
}

function ChatBubble({ isLoggedIn, fabLabel, guestInputs }: ChatBubbleProps) {
  const [open, setOpen] = useState(false);
  const [widgetChatOpen, setWidgetChatOpen] = useState(false);
  // Callback-ref state (not useRef): the button remounts after every chat
  // open/close cycle and the lift effect must re-bind to the new node.
  const [fabEl, setFabEl] = useState<HTMLButtonElement | null>(null);

  // Lift the FAB clear of the footer and the theme's sticky add-to-cart bar.
  useFabLift(fabEl);

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
      ref={setFabEl}
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

  // The Health Roadmap tool renders its own chat FAB, so suppress the
  // site-wide bubble on any page where the tool is present (prevents a double
  // bubble on the homepage / roadmap page). On stores/pages without the tool,
  // the site chat shows everywhere. Replaces the old per-page liquid rules.
  if (document.getElementById('health-tool-root')) return;

  setAssistantName(resolveAssistantName(container));

  const isLoggedIn = container.dataset.loggedIn === 'true';
  const productTitle = container.dataset.productTitle;

  const fabLabel = productTitle
    ? `Questions about ${productTitle}?`
    : (container.dataset.fabLabel || 'Need help? Ask here');

  // Always send the cached plan as chat context — local-first (v2) means the
  // server has no health data for logged-in customers either (the v1 tables
  // were purged June 2026), so the client payload is the only possible source.
  const guestInputs = loadGuestInputs();

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
