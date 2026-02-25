import React, { useEffect, useRef, useState } from 'react';
import { sendFeedback } from '../lib/api';

type FormStatus = 'idle' | 'sending' | 'sent' | 'error';

interface FeedbackFormProps {
  /** Start with the form expanded (no toggle button shown). */
  initialExpanded?: boolean;
  /** Called when the form is closed/cancelled. */
  onClose?: () => void;
  /** Show the "View source code" link. Default true. */
  showSourceLink?: boolean;
}

export function FeedbackForm({ initialExpanded = false, onClose, showSourceLink = true }: FeedbackFormProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<FormStatus>('idle');

  const formRef = useRef<HTMLFormElement>(null);
  const canSubmit = email.trim() !== '' && message.trim() !== '' && status !== 'sending';

  useEffect(() => {
    if (expanded) {
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
    }
  }, [expanded]);

  function handleClose() {
    setExpanded(false);
    setStatus('idle');
    onClose?.();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setStatus('sending');
    const success = await sendFeedback(email.trim(), message.trim());

    if (success) {
      setStatus('sent');
      setEmail('');
      setMessage('');
      setTimeout(() => {
        setStatus('idle');
        setExpanded(false);
        onClose?.();
      }, 3000);
    } else {
      setStatus('error');
    }
  }

  return (
    <div className="feedback-section" id={initialExpanded ? undefined : 'health-feedback'}>
      {status === 'sent' ? (
        <p className="feedback-success">Thank you for your feedback!</p>
      ) : !expanded ? (
        <div className="feedback-links">
          <button
            type="button"
            className="feedback-btn"
            onClick={() => setExpanded(true)}
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
          {status === 'error' && (
            <p className="feedback-error">Failed to send. Please try again.</p>
          )}
          <div className="feedback-actions">
            <button
              type="submit"
              className="btn-primary feedback-submit"
              disabled={!canSubmit}
            >
              {status === 'sending' ? 'Sending...' : 'Send'}
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
