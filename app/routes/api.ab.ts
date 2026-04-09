import { json, type ActionFunctionArgs } from '@remix-run/node';
import { z } from 'zod';
import { authenticate } from '../shopify.server';
import { recordABEvent } from '../lib/supabase.server';
import { createRateLimiter } from '../lib/rate-limiter';

// 10 events per minute per visitor (generous, prevents abuse)
const checkABRateLimit = createRateLimiter(10, 60_000, 5 * 60_000);

const abEventSchema = z.object({
  testId: z.string().uuid(),
  variantId: z.string().min(1).max(10),
  visitorId: z.string().uuid(),
});

export async function action({ request }: ActionFunctionArgs) {
  await authenticate.public.appProxy(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const eventData = b?.impression || b?.conversion;
  const eventType: 'impression' | 'conversion' | null = b?.impression ? 'impression'
    : b?.conversion ? 'conversion'
    : null;

  if (!eventData || !eventType) {
    return json({ success: false, error: 'Missing impression or conversion' }, { status: 400 });
  }

  const parsed = abEventSchema.safeParse(eventData);
  if (!parsed.success) {
    return json({ success: false, error: 'Invalid event data' }, { status: 400 });
  }

  if (!checkABRateLimit(parsed.data.visitorId)) {
    return json({ success: false, error: 'Rate limited' }, { status: 429 });
  }

  await recordABEvent(
    parsed.data.testId,
    parsed.data.variantId,
    parsed.data.visitorId,
    eventType!,
  );

  return json({ success: true });
}
