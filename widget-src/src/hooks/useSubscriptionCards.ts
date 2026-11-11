/**
 * Subscription change cards under the chat's answers (US-59), by assistant
 * message id, this tab only: never persisted, synced or sent anywhere but the
 * confirm. Split from useChatState (file budget).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmSubscriptionChange, type SubscriptionCard, type SubscriptionResult } from '../lib/subscription-card';

/** A subscription change card under an answer (US-59): idle, sending, or closed with its outcome. */
export interface SubscriptionCardState {
  card: SubscriptionCard;
  phase: 'idle' | 'sending' | 'closed';
  /** The last outcome; a 'busy' one leaves the card open to try again. */
  result?: SubscriptionResult;
  dismissed?: boolean;
}

export function useSubscriptionCards() {
  const [cardsById, setCardsById] = useState<Record<string, SubscriptionCardState>>({});
  /** The customer pressed Confirm (US-59): the one request that makes the change. */
  const cardsRef = useRef(cardsById);
  const setCards = useCallback((next: Record<string, SubscriptionCardState>) => { cardsRef.current = next; setCardsById(next); }, []);
  useEffect(() => { cardsRef.current = cardsById; }, [cardsById]);
  const confirmSubscription = useCallback(async (messageId: string) => {
    const entry = cardsRef.current[messageId];
    // The ref flips to 'sending' synchronously, so a double click sends once.
    if (!entry || entry.phase !== 'idle') return;
    setCards({ ...cardsRef.current, [messageId]: { ...entry, phase: 'sending' } });
    const result = await confirmSubscriptionChange(entry.card);
    // The usage signal is counted by the server's confirm route (US-59), on every bundle.
    // 'busy' leaves the card open to try again; every other outcome closes it.
    setCards({ ...cardsRef.current, [messageId]: { ...entry, result, phase: result.code === 'busy' ? 'idle' : 'closed' } });
  }, [setCards]);

  const dismissSubscription = useCallback((messageId: string) => {
    const entry = cardsRef.current[messageId];
    if (entry?.phase === 'idle') setCards({ ...cardsRef.current, [messageId]: { ...entry, phase: 'closed', dismissed: true } });
  }, [setCards]);

  return { cardsById, setCardsById, confirmSubscription, dismissSubscription };
}
