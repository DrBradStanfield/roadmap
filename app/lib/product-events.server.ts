import { z } from 'zod';
// Deep relative import (not '@roadmap/health-core'): the Docker build runs
// `npm ci` before COPY, so the workspace symlink never exists in the image —
// same reason chat.server.ts / email.server.ts import health-core this way.
import { PRODUCT_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { supabaseAdmin } from './supabase.server';

// Metadata is a closed allow-list: no free text, no health values. `provider`
// mirrors the storage backendId; `count` is a small integer (e.g. files in an
// upload batch). Anything else is rejected by .strict().
const metadataSchema = z
  .object({
    provider: z.enum(['google-drive', 'dropbox', 'github', 'webdav', 'local', 'typed']).optional(),
    count: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

export const productEventSchema = z.object({
  eventName: z.enum(PRODUCT_EVENT_NAMES),
  visitorId: z.string().uuid(),
  metadata: metadataSchema.optional(),
});

export type ProductEventInput = z.infer<typeof productEventSchema>;

/**
 * Sentinel visitor for events the SERVER originates, where no browser visitor
 * exists: a plan-ready email send, a Resend bounce/complaint webhook, an email
 * link click (US-22). Deliberately NOT the recipient's address or any hash of
 * it — product_events stays anonymous counters, so these events answer "how
 * many bounced", never "who bounced".
 */
export const SERVER_VISITOR_ID = '00000000-0000-0000-0000-000000000000';

/** Fire-and-forget server-side counter. Never throws — callers are hot paths. */
export async function recordServerEvent(
  eventName: ProductEventInput['eventName'],
  metadata?: ProductEventInput['metadata'],
): Promise<void> {
  try {
    await recordProductEvent({ eventName, visitorId: SERVER_VISITOR_ID, metadata });
  } catch {
    /* counters must never break the operation they measure */
  }
}

export function parseProductEvent(body: unknown): ProductEventInput | null {
  const parsed = productEventSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export async function recordProductEvent(event: ProductEventInput): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { error } = await supabaseAdmin.from('product_events').insert({
    event_name: event.eventName,
    visitor_id: event.visitorId,
    metadata: event.metadata ?? null,
  });
  if (error) {
    console.error('Failed to record product event:', error.message);
    return false;
  }
  return true;
}

// Fire-and-forget mirror of the feedback email — the email to Brad remains the
// primary delivery; a DB error here must never block or fail the submission.
export async function recordFeedbackSubmission(
  email: string,
  message: string,
  customerId: string | null,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { error } = await supabaseAdmin.from('feedback_submissions').insert({
    email,
    message,
    customer_id: customerId,
  });
  if (error) {
    console.error('Failed to record feedback submission:', error.message);
    return false;
  }
  return true;
}
