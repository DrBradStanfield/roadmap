import { type ActionFunctionArgs } from "react-router";
import { authenticate } from '../shopify.server';
import { createRateLimiter } from '../lib/rate-limiter';
import { isBotUA } from '../lib/bot-detect';
import { parseProductEvent, recordProductEvent } from '../lib/product-events.server';

// 20 events per minute per visitor — a full session emits well under this.
const checkEventRateLimit = createRateLimiter(20, 60_000, 5 * 60_000);

export async function action({ request }: ActionFunctionArgs) {
  await authenticate.public.appProxy(request);

  if (isBotUA(request.headers.get('user-agent'))) {
    return Response.json({ success: false, error: 'bot' });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const event = parseProductEvent(body);
  if (!event) {
    return Response.json({ success: false, error: 'Invalid event' }, { status: 400 });
  }

  if (!checkEventRateLimit(event.visitorId)) {
    return Response.json({ success: false, error: 'Rate limited' }, { status: 429 });
  }

  await recordProductEvent(event);

  return Response.json({ success: true });
}
