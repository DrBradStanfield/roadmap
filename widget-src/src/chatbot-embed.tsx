/**
 * Embedded chatbot widget — IIFE entry point.
 * Mounted as a section block (target: "section") anywhere on the storefront.
 * Syncs live with the FAB and inline ChatSection via BroadcastChannel.
 */
import { createRoot } from 'react-dom/client';
import { ChatEmbed } from './components/ChatEmbed';
import { ErrorBoundary } from './components/ErrorBoundary';
import { loadGuestInputs } from './lib/storage';
import { initSentry } from './lib/sentry';
import './styles.css';

initSentry();

function mount() {
  const container = document.getElementById('health-chatbot-embed-root');
  if (!container) return;

  const isLoggedIn = container.dataset.loggedIn === 'true';

  const guestInputs = isLoggedIn ? null : loadGuestInputs();

  const root = createRoot(container);
  root.render(
    <ErrorBoundary>
      <ChatEmbed isLoggedIn={isLoggedIn} guestInputs={guestInputs} />
    </ErrorBoundary>,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
