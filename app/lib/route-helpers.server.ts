/**
 * Shared helpers for API route handlers.
 * Extracted from api.measurements, api.reminders, api.user-data to eliminate duplication.
 */

import * as Sentry from '@sentry/remix';
import { authenticate } from '../shopify.server';
import { getOrCreateSupabaseUser, createUserClient } from './supabase.server';

/** Customer IDs exempt from rate limits (env: comma-separated Shopify customer IDs). */
export const EXEMPT_CUSTOMERS = new Set(
  (process.env.RATE_LIMIT_EXEMPT_CUSTOMERS || '').split(',').map(s => s.trim()).filter(Boolean),
);

/**
 * Extract and validate the Shopify customer ID from the app proxy request.
 * Returns null if missing or non-numeric (defense-in-depth against malformed IDs).
 */
export function getCustomerId(request: Request): string | null {
  const url = new URL(request.url);
  const id = url.searchParams.get('logged_in_customer_id');
  return id && /^\d+$/.test(id) ? id : null;
}

/**
 * Look up customer email and name from Shopify Admin API.
 */
export async function getCustomerInfo(
  admin: any,
  customerId: string,
): Promise<{ email: string; firstName: string | null; lastName: string | null } | null> {
  try {
    const response = await admin.graphql(`
      query getCustomer($id: ID!) {
        customer(id: $id) {
          email
          firstName
          lastName
        }
      }
    `, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const result = await response.json();
    const customer = result?.data?.customer;
    if (!customer?.email) return null;
    return {
      email: customer.email,
      firstName: customer.firstName || null,
      lastName: customer.lastName || null,
    };
  } catch (error) {
    console.error('Error looking up customer info:', error);
    return null;
  }
}

/**
 * Full auth flow for app proxy routes that need a Supabase user client.
 * Authenticates via Shopify HMAC, looks up customer info, creates/retrieves Supabase user.
 */
export async function getAuthenticatedUser(request: Request) {
  const { admin } = await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) return null;

  const customerInfo = admin ? await getCustomerInfo(admin, customerId) : null;
  if (!customerInfo) return null;

  const userId = await getOrCreateSupabaseUser(
    customerId, customerInfo.email, customerInfo.firstName, customerInfo.lastName,
  );
  return { userId, customerId, client: createUserClient(userId), admin };
}

/** UUID format: 8-4-4-4-12 hex chars */
const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/**
 * Validate that a string looks like a UUID (for unsubscribe tokens, etc.).
 */
export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

// ---------------------------------------------------------------------------
// Order lookup for chat context
// ---------------------------------------------------------------------------

/**
 * Fetch recent orders for a Shopify customer (for chat context).
 * Returns a formatted string summary. Never throws — returns empty string on failure.
 */
export async function getCustomerOrders(
  admin: any,
  customerId: string,
): Promise<string> {
  try {
    const response = await admin.graphql(`
      query getCustomerOrders($id: ID!) {
        customer(id: $id) {
          orders(first: 5, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                name
                createdAt
                displayFulfillmentStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                lineItems(first: 10) {
                  edges {
                    node { title quantity }
                  }
                }
                fulfillments {
                  status
                  trackingInfo { url number company }
                }
              }
            }
          }
        }
      }
    `, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const result = await response.json();
    const edges = result?.data?.customer?.orders?.edges;
    if (result?.errors) console.error('Order GraphQL errors:', JSON.stringify(result.errors));
    if (!edges?.length) return '';

    const lines: string[] = [];
    for (const { node: order } of edges) {
      const date = new Date(order.createdAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
      });
      const money = order.totalPriceSet?.shopMoney;
      const total = money ? `$${parseFloat(money.amount).toFixed(2)} ${money.currencyCode}` : '';
      const items = order.lineItems?.edges
        ?.map((e: any) => `${e.node.title} ×${e.node.quantity}`)
        .join(', ') ?? '';
      const tracking: string[] = [];
      for (const f of order.fulfillments ?? []) {
        for (const t of f.trackingInfo ?? []) {
          if (t.url) tracking.push(`${t.company || 'Tracking'}: ${t.url}`);
        }
      }

      lines.push(`Order ${order.name} (${date}) — ${total}`);
      lines.push(`  Status: ${order.displayFulfillmentStatus || 'UNFULFILLED'}`);
      lines.push(`  Items: ${items}`);
      if (tracking.length) lines.push(`  Tracking: ${tracking.join(', ')}`);
      lines.push('');
    }
    return lines.join('\n');
  } catch (error) {
    console.error('Error fetching customer orders:', error);
    Sentry.captureException(error, { tags: { feature: 'customer_orders_chat' } });
    return '';
  }
}

const APPSTLE_SUBSCRIBER_TAG = 'appstle_subscription_active_customer';

/**
 * Check if a Shopify customer has an active Appstle subscription.
 * Returns 'subscriber' if the customer has the tag, 'free' otherwise.
 */
export async function checkSubscriptionFromTags(
  admin: any,
  customerId: string,
): Promise<'subscriber' | 'free'> {
  try {
    const response = await admin.graphql(`
      query getCustomerTags($id: ID!) {
        customer(id: $id) {
          tags
        }
      }
    `, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const result = await response.json();
    const tags: string[] = result?.data?.customer?.tags ?? [];
    return tags.includes(APPSTLE_SUBSCRIBER_TAG) ? 'subscriber' : 'free';
  } catch (error) {
    console.error('Error checking subscription tags:', error);
    return 'free'; // Fail safe — default to free tier
  }
}

/**
 * Tag a Shopify customer with "roadmap-user" for Klaviyo audience sync.
 * Fire-and-forget — never throws. tagsAdd is idempotent (no-op if tag exists).
 */
export async function tagShopifyCustomer(admin: any, customerId: string): Promise<void> {
  try {
    const response = await admin.graphql(`
      mutation addTags($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { message }
        }
      }
    `, {
      variables: {
        id: `gid://shopify/Customer/${customerId}`,
        tags: ['roadmap-user'],
      },
    });
    const result = await response.json();
    const userErrors = result?.data?.tagsAdd?.userErrors;
    if (userErrors?.length) {
      console.warn('Shopify tagsAdd userErrors:', userErrors);
    }
  } catch (error) {
    console.error('Shopify customer tagging error:', error);
    Sentry.captureException(error, { tags: { feature: 'shopify_customer_tag' } });
  }
}
