/**
 * Webhook handler for Shopify orders/paid — adds message credits for pack purchases.
 *
 * Idempotent: duplicate order IDs are ignored via unique constraint on
 * message_credit_transactions.order_id.
 *
 * Returns 500 on transient errors so Shopify retries the webhook.
 */
import type { ActionFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { authenticate } from '../shopify.server';
import { addMessageCredits, getUserIdByCustomerId, logAudit } from '../lib/supabase.server';
import { VARIANT_CREDIT_MAP } from '../lib/message-packs';

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

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

    const userId = await getUserIdByCustomerId(customerId);
    if (!userId) {
      // User hasn't signed up yet — return 500 so Shopify retries later
      console.warn(`No Supabase user found for Shopify customer ${customerId}, will retry`);
      return new Response(null, { status: 500 });
    }

    const orderId = `gid://shopify/Order/${order.id}`;

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
