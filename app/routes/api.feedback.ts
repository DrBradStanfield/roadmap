import { type ActionFunctionArgs } from "react-router";
import * as Sentry from '@sentry/react-router';
import * as z from '../../packages/health-core/src/zod';
import { authenticate } from '../shopify.server';
import { sendFeedbackEmail } from '../lib/email.server';
import { recordFeedbackSubmission } from '../lib/product-events.server';
import { BODY_TOO_LARGE, getClientIp, parseSimpleRequestJson } from '../lib/local-first-route.server';
import { getCustomerId } from '../lib/route-helpers.server';
import { createRateLimiter } from '../lib/rate-limiter';

// 3 submissions per hour per IP — the same limiter every other route uses.
const checkFeedbackRateLimit = createRateLimiter(3, 60 * 60_000, 10 * 60_000);

const feedbackSchema = z.object({
  email: z.email().max(200),
  message: z.string().min(1).max(2000),
  // Honeypot: a filled field fails max(0), so the request is a 400 before any
  // insert or send. The trap is the schema — there is no second check below.
  website: z.string().max(0).optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  // HMAC verification — proves request came through Shopify app proxy
  await authenticate.public.appProxy(request);

  // Counted as it is checked, before anything can throw: a Resend outage used
  // to throw past the counter and hand an attacker unlimited inserts.
  if (!checkFeedbackRateLimit(getClientIp(request, 'shopify'))) {
    return Response.json({ success: false, error: 'Too many requests. Please try again later.' }, { status: 429 });
  }

  try {
    const body = await parseSimpleRequestJson(request);
    if (body === BODY_TOO_LARGE) return Response.json({ success: false, error: 'Request too large' }, { status: 413 });
    const parsed = feedbackSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json({ success: false, error: 'Invalid input' }, { status: 400 });
    }

    // Optional customer ID for context, only when Shopify vouched for it.
    const customerId = getCustomerId(request);

    // Queryable mirror of the email (weekly product-health loop reads this).
    // Fire-and-forget: a DB failure must never block the feedback email.
    recordFeedbackSubmission(parsed.data.email, parsed.data.message, customerId).catch(() => {});

    const sent = await sendFeedbackEmail(parsed.data.email, parsed.data.message, customerId);

    if (!sent) {
      return Response.json({ success: false, error: 'Failed to send feedback' }, { status: 500 });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Error processing feedback:', error);
    Sentry.captureException(error);
    return Response.json({ success: false, error: 'Server error' }, { status: 500 });
  }
}
