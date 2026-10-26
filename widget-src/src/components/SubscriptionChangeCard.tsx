/**
 * The confirm card for one subscription change (US-59). Nothing changes
 * until the customer presses Confirm; the card then shows the outcome in
 * plain words. Text only (no HTML from the server is rendered).
 */
import { cardLines, cardTitle, resultText } from '../lib/subscription-card';
import type { SubscriptionCardState } from '../hooks/useChatState';

interface Props {
  entry: SubscriptionCardState;
  onConfirm: () => void;
  onDismiss: () => void;
}

export function SubscriptionChangeCard({ entry, onConfirm, onDismiss }: Props) {
  const { card, phase, result, dismissed } = entry;
  return (
    <div className="chat-sub-card" role="group" aria-label={cardTitle(card.action)}>
      <p className="chat-sub-card-title">{cardTitle(card.action)}</p>
      {cardLines(card).map((line) => <p key={line} className="chat-sub-card-line">{line}</p>)}
      {result && <p className="chat-sub-card-result" role="status">{resultText(card, result)}</p>}
      {dismissed && <p className="chat-sub-card-result" role="status">Nothing was changed.</p>}
      {phase !== 'closed' && (
        <div className="chat-sub-card-buttons">
          <button type="button" className="chat-sub-card-confirm" onClick={onConfirm} disabled={phase === 'sending'}>
            {phase === 'sending' ? 'Working…' : 'Confirm'}
          </button>
          <button type="button" className="chat-sub-card-dismiss" onClick={onDismiss} disabled={phase === 'sending'}>Not now</button>
        </div>
      )}
    </div>
  );
}
