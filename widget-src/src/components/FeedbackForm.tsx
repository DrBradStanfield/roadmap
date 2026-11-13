import React, { useEffect, useReducer, useRef, useState } from 'react';
import { sendFeedback } from '../lib/server-api';

/**
 * The form's mode (US-19 AC3): closed (the "Send feedback" link), open, sending, failed (open,
 * saying so) or sent (the thank-you, which closes itself after 3 s). A send's answer counts only
 * while it is sending, so one that ends after Cancel changes nothing.
 */
export type FeedbackMode = 'closed' | 'open' | 'sending' | 'failed' | 'sent';
export type FeedbackEvent = 'expand' | 'close' | 'send' | 'sendFailed' | 'sendOk' | 'thanked';

export function feedbackTransition(state: FeedbackMode, event: FeedbackEvent): FeedbackMode {
  switch (event) {
    case 'expand': return state === 'closed' ? 'open' : state;
    case 'close': return state === 'open' || state === 'sending' || state === 'failed' ? 'closed' : state;
    case 'send': return state === 'open' || state === 'failed' ? 'sending' : state;
    case 'sendFailed': return state === 'sending' ? 'failed' : state;
    case 'sendOk': return state === 'sending' ? 'sent' : state;
    case 'thanked': return state === 'sent' ? 'closed' : state;
  }
}

interface FeedbackFormProps {
  /** Start with the form expanded (no toggle button shown). */
  initialExpanded?: boolean;
  /** Called when the form is closed/cancelled. */
  onClose?: () => void;
  /** Show the "View source code" link. Default true. */
  showSourceLink?: boolean;
}

export function FeedbackForm({ initialExpanded = false, onClose, showSourceLink = true }: FeedbackFormProps) {
  const [mode, send] = useReducer(feedbackTransition, initialExpanded ? 'open' : 'closed');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');

  const formRef = useRef<HTMLFormElement>(null);
  const formShown = mode === 'open' || mode === 'sending' || mode === 'failed';
  const canSubmit = email.trim() !== '' && message.trim() !== '' && mode !== 'sending';
  // The latest onClose, so a parent's new callback each render does not restart the thank-you.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (formShown) {
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
    }
  }, [formShown]);

  // The thank-you closes the form after 3 s; gone with the form, it never fires.
  useEffect(() => {
    if (mode !== 'sent') return;
    const timer = setTimeout(() => { send('thanked'); onCloseRef.current?.(); }, 3000);
    return () => clearTimeout(timer);
  }, [mode]);

  function handleClose() {
    send('close');
    onClose?.();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    send('send');
    const success = await sendFeedback(email.trim(), message.trim());

    if (success) {
      send('sendOk');
      setEmail('');
      setMessage('');
    } else {
      send('sendFailed');
    }
  }

  return (
    <div className="feedback-section" id={initialExpanded ? undefined : 'health-feedback'}>
      {mode === 'sent' ? (
        <p className="feedback-success">Thank you for your feedback!</p>
      ) : !formShown ? (
        <div className="feedback-links">
          <button
            type="button"
            className="feedback-btn"
            onClick={() => send('expand')}
          >
            Send feedback
          </button>
          {showSourceLink && (
            <a
              href="https://github.com/DrBradStanfield/roadmap"
              target="_blank"
              rel="noopener noreferrer"
              className="source-code-link"
            >
              View source code
            </a>
          )}
        </div>
      ) : (
        <form ref={formRef} className="feedback-form" onSubmit={handleSubmit}>
          <label className="feedback-label">
            Email
            <input
              type="email"
              className="feedback-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              maxLength={200}
            />
          </label>
          <label className="feedback-label">
            Message
            <textarea
              className="feedback-textarea"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Your feedback..."
              required
              maxLength={2000}
              rows={4}
            />
          </label>
          {/* Honeypot — hidden from real users */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', opacity: 0 }}>
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </div>
          {mode === 'failed' && (
            <p className="feedback-error">Failed to send. Please try again.</p>
          )}
          <div className="feedback-actions">
            <button
              type="submit"
              className="btn-primary feedback-submit"
              disabled={!canSubmit}
            >
              {mode === 'sending' ? 'Sending...' : 'Send'}
            </button>
            <button
              type="button"
              className="feedback-cancel"
              onClick={handleClose}
            >
              Cancel
            </button>
          </div>
          {showSourceLink && (
            <a
              href="https://github.com/DrBradStanfield/roadmap"
              target="_blank"
              rel="noopener noreferrer"
              className="source-code-link"
            >
              View source code
            </a>
          )}
        </form>
      )}
    </div>
  );
}
