/**
 * The `save_retry` counter's words (US-09 AC30): what started a retry of a
 * failed cloud save, and how it ended. A leaf, so the server's event schema
 * takes them without the record engine.
 */
export const SAVE_RETRY_TRIGGERS = ['online', 'focus'] as const;
export const SAVE_RETRY_OUTCOMES = ['landed', 'failed'] as const;
export interface SaveRetry {
  trigger: (typeof SAVE_RETRY_TRIGGERS)[number];
  outcome: (typeof SAVE_RETRY_OUTCOMES)[number];
}
