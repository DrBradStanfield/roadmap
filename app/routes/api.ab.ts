import { type ActionFunctionArgs } from "react-router";
import { z } from 'zod';
import { authenticate } from '../shopify.server';
import { getActiveABTests, recordABEvent, type ABEventType } from '../lib/supabase.server';
import { createRateLimiter } from '../lib/rate-limiter';
import { isBotUA } from '../lib/bot-detect';
import { getClientIp } from '../lib/local-first-route.server';

// 10 events per minute per visitor (generous, prevents abuse)
const checkABRateLimit = createRateLimiter(10, 60_000, 5 * 60_000);
// The visitor id is in the body, so a script that rotates it has no limit at
// all. The IP is the one key the caller cannot choose. Loose enough that a
// whole CGNAT range of real shoppers never notices.
const checkABIpRateLimit = createRateLimiter(600, 60 * 60_000, 10 * 60_000);

const abEventSchema = z.object({
  testId: z.string().uuid(),
  variantId: z.string().min(1).max(10),
  visitorId: z.string().uuid(),
});

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

  const b = body as Record<string, unknown>;
  const eventData = b?.impression || b?.conversion;
  const eventType: ABEventType | null = b?.impression ? 'impression'
    : b?.conversion ? 'conversion'
    : null;

  if (!eventData || !eventType) {
    return Response.json({ success: false, error: 'Missing impression or conversion' }, { status: 400 });
  }

  const parsed = abEventSchema.safeParse(eventData);
  if (!parsed.success) {
    return Response.json({ success: false, error: 'Invalid event data' }, { status: 400 });
  }

  if (!checkABIpRateLimit(getClientIp(request, 'shopify')) || !checkABRateLimit(parsed.data.visitorId)) {
    return Response.json({ success: false, error: 'Rate limited' }, { status: 429 });
  }

  // The test id is held by a live foreign key; the variant id is not held by
  // anything, so an invented one would land in ab_events and skew a result.
  const test = (await getActiveABTests()).find((t) => t.id === parsed.data.testId);
  if (!test?.variants.some((v) => v.id === parsed.data.variantId)) {
    return Response.json({ success: false, error: 'Unknown test or variant' }, { status: 400 });
  }

  await recordABEvent(
    parsed.data.testId,
    parsed.data.variantId,
    parsed.data.visitorId,
    eventType!,
  );

  return Response.json({ success: true });
}
