/**
 * Webhook handler for Shopify orders/paid — adds message credits for pack purchases.
 *
 * Idempotent: duplicate order IDs are ignored via unique constraint on
 * message_credit_transactions.order_id.
 *
 * Returns 500 on transient errors so Shopify retries the webhook.
 */
import type { ActionFunctionArgs } from 'react-router';
import * as Sentry from '@sentry/react-router';
import { authenticate } from '../shopify.server';
import { addMessageCredits, getUserIdByCustomerId, logAudit, recordUnprovenPaidOrder } from '../lib/supabase.server';
import { VARIANT_CREDIT_MAP } from '../lib/message-packs';
import { cappedRequest, WEBHOOK_BODY_CAP } from '../lib/capped-body.server';

export const action = async ({ request }: ActionFunctionArgs) => {
  // The library reads the whole body before its HMAC check (US-09 AC25).
  const capped = await cappedRequest(request, WEBHOOK_BODY_CAP);
  if (!capped) return new Response(null, { status: 413 });
  const { payload, topic, shop } = await authenticate.webhook(capped);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const order = payload as any;
    const lineItems: any[] = order?.line_items ?? [];
    const customerId = order?.customer?.id?.toString();

    if (!customerId || !lineItems.length || !order.id) {
      return new Response();
    }

    // Check if any line items are message packs (skip non-pack orders early)
    const packItems = lineItems.filter((item: any) => {
      const vid = item.variant_id?.toString();
      return vid && VARIANT_CREDIT_MAP[vid];
    });
    if (!packItems.length) return new Response();

    const user = await getUserIdByCustomerId(customerId);
    if (!user) {
      // No linked user yet — return 500 so Shopify retries later; credits are
      // idempotent per order. The log names no customer (US-09 AC27).
      console.warn('orders/paid: no Supabase user for this customer yet, will retry');
      return new Response(null, { status: 500 });
    }

    const orderId = `gid://shopify/Order/${order.id}`;

    if (!user.proven) {
      // A link without admin-written proof is never credited (US-09 AC27). Store a
      // value-free record for Brad to credit by hand once the backfill proves the
      // link, then answer 200 so Shopify stops retrying; if it cannot be stored,
      // 500 so Shopify retries rather than the credit being lost.
      if (!(await recordUnprovenPaidOrder(user.userId, orderId))) return new Response(null, { status: 500 });
      Sentry.captureMessage('orders/paid for an unproven Shopify link; credit by hand after the backfill', {
        level: 'warning', tags: { feature: 'message_credits' }, extra: { orderId, profileId: user.userId },
      });
      return new Response();
    }
    const userId = user.userId;

    for (const item of packItems) {
      const variantId = item.variant_id?.toString();
      const quantity = Math.min(Math.max(1, item.quantity ?? 1), 10);
      const creditAmount = VARIANT_CREDIT_MAP[variantId!] * quantity;

      const newBalance = await addMessageCredits(userId, creditAmount, orderId);
      if (newBalance === null) {
        console.log(`Order ${orderId} already processed (duplicate webhook)`);
        continue;
      }

      logAudit(userId, 'MESSAGE_CREDITS_PURCHASED', 'chat', orderId, {
        amount: creditAmount,
        variantId,
        newBalance,
      });

      console.log(`Added ${creditAmount} message credits for user ${userId} (order ${order.id})`);
    }
  } catch (error) {
    console.error('Error processing orders/paid webhook:', error);
    Sentry.captureException(error, { tags: { feature: 'message_credits' } });
    return new Response(null, { status: 500 });
  }

  return new Response();
};
