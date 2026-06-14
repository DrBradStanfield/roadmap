import { type ActionFunctionArgs } from "react-router";
import * as Sentry from '@sentry/react-router';
import { z } from 'zod';
import { authenticate } from '../shopify.server';
import { sendFeedbackEmail } from '../lib/email.server';
import { getClientIp } from '../lib/route-helpers.server';

// Rate limit: 3 submissions per hour per IP
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;
const RATE_LIMIT_MAX = 3;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// Clean up stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 10 * 60_000);

function isRateLimited(ip: string): boolean {
  const entry = rateLimitMap.get(ip);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= RATE_LIMIT_MAX;
}

function recordRequest(ip: string): void {
  const entry = rateLimitMap.get(ip);
  const now = Date.now();
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count++;
  }
}

const feedbackSchema = z.object({
  email: z.string().email().max(200),
  message: z.string().min(1).max(2000),
  website: z.string().max(0).optional(), // honeypot — must be empty
});

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  // HMAC verification — proves request came through Shopify app proxy
  await authenticate.public.appProxy(request);

  const ip = getClientIp(request);
  if (isRateLimited(ip)) {
    return Response.json({ success: false, error: 'Too many requests. Please try again later.' }, { status: 429 });
  }

  try {
    const body = await request.json();
    const parsed = feedbackSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json({ success: false, error: 'Invalid input' }, { status: 400 });
    }

    // Honeypot triggered — silently succeed without sending
    if (parsed.data.website) {
      return Response.json({ success: true });
    }

    // Extract optional customer ID for context
    const url = new URL(request.url);
    const customerId = url.searchParams.get('logged_in_customer_id') || null;

    const sent = await sendFeedbackEmail(parsed.data.email, parsed.data.message, customerId);

    recordRequest(ip);

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
