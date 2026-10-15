/**
 * POST /api/subscription-action { token, reason? } — the customer's own
 * confirm of a subscription change card (US-49). Commerce only: 404 unless
 * subscription actions are enabled (CHAT_SUBSCRIPTION_ACTIONS=on and
 * CHAT_SURFACE=brand, so never on the education app).
 *
 * The change itself happens in the private customer-service gateway, which
 * checks Shopify's signature on THIS request (forwarded as signed), the
 * one-time token, every eligibility rule and its own limits, then makes one
 * Appstle call and reads it back. This route only checks the app-proxy
 * signature, that a customer is logged in, the JSON shape, and a per-customer
 * rate limit. A JSON content type is required, so another site cannot send a
 * confirm from a plain form; and the token only ever appears in the chat's own
 * response, which another site cannot read.
 */
import { type ActionFunctionArgs } from 'react-router';
import { z } from 'zod';
import { authenticate } from '../shopify.server';
import { getCustomerId } from '../lib/route-helpers.server';
import { createRateLimiter } from '../lib/rate-limiter';
import { recordServerEvent } from '../lib/product-events.server';
import {
  subscriptionActionsEnabled,
  postSubscriptionAction,
  invalidateSubscriptions,
  SUBSCRIPTION_REASONS,
} from '../lib/subscription-gateway.server';

// The gateway has the real limits (3 changes a day); this only stops a loop hammering it.
const checkRateLimit = createRateLimiter(10, 60 * 60_000, 10 * 60_000);

const bodySchema = z.object({
  token: z.string().min(20).max(1300),
  reason: z.enum(SUBSCRIPTION_REASONS).optional().nullable(),
}).strict();

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  if (!subscriptionActionsEnabled()) return Response.json({ success: false, error: 'Not found' }, { status: 404 });

  // Throws the framework's 400 Response when the app-proxy signature is missing or wrong.
  await authenticate.public.appProxy(request);
  const customerId = getCustomerId(request);
  if (!customerId) return Response.json({ success: false, error: 'login_required' }, { status: 401 });

  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
    return Response.json({ success: false, error: 'JSON required' }, { status: 415 });
  }
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return Response.json({ success: false, error: 'Invalid input' }, { status: 400 });

  if (!checkRateLimit(customerId)) return Response.json({ success: false, status: 'refused', code: 'busy' }, { status: 429 });

  const result = await postSubscriptionAction(request, parsed.data.token, parsed.data.reason ?? null);
  // Whatever happened, the next chat turn reads the subscriptions again.
  invalidateSubscriptions(customerId);
  // The usage signal (US-49), counted here because only the server knows the store took it. Name only.
  if (result.status === 'done' || result.status === 'accepted') void recordServerEvent('subscription_action_confirmed');
  return Response.json({ success: result.status !== 'refused' && result.status !== 'unconfirmed', ...result });
}

