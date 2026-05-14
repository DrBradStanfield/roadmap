#!/usr/bin/env tsx
/**
 * Backfill Klaviyo subscribers from Shopify customers tagged "roadmap".
 *
 * The app only subscribes users to Klaviyo via the welcome email flow, which
 * skips anyone who already has welcome_email_sent=true OR who was tagged with
 * "roadmap" in Shopify before the integration existed. This script closes that
 * gap by sweeping every Shopify customer with the "roadmap" tag and pushing
 * their email into the Klaviyo list.
 *
 * Usage:
 *   npx tsx scripts/backfill-klaviyo.ts                  # dry run, prints what would be done
 *   npx tsx scripts/backfill-klaviyo.ts --apply          # actually subscribe
 *   npx tsx scripts/backfill-klaviyo.ts --tag roadmap-user --apply  # different tag
 *   npx tsx scripts/backfill-klaviyo.ts --limit 50       # cap pages (useful when testing)
 *
 * Required env (loaded from .env via dotenv):
 *   SHOPIFY_SHOP            e.g. "drstanfield.myshopify.com"
 *   SHOPIFY_ACCESS_TOKEN    Admin API access token with read_customers
 *   KLAVIYO_API_KEY
 *   KLAVIYO_LIST_ID
 *
 * The roadmap .env only has the Klaviyo keys. Easiest way to bring in the
 * Shopify credentials from the claude_business workspace:
 *
 *   set -a && source "$HOME/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/claude-integration/.env" && set +a && \
 *     npx tsx scripts/backfill-klaviyo.ts --apply
 *
 * Idempotency: Klaviyo's bulk subscribe job is idempotent — re-subscribing an
 * already-subscribed profile is a no-op. Safe to re-run.
 */

import dotenv from 'dotenv';
// Override: roadmap .env is the source of truth for this project's keys, so it
// wins over anything sourced into the shell first (e.g. claude_business .env
// which has a different KLAVIYO_API_KEY).
dotenv.config({ override: true });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;

const SHOPIFY_API_VERSION = '2024-10';
const KLAVIYO_API_REVISION = '2024-10-15';
const KLAVIYO_BATCH_SIZE = 100; // Klaviyo bulk job max
const SHOPIFY_PAGE_SIZE = 250;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const tagIdx = args.indexOf('--tag');
const TAG = tagIdx >= 0 && args[tagIdx + 1] ? args[tagIdx + 1] : 'roadmap';
const limitIdx = args.indexOf('--limit');
const PAGE_LIMIT = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const missing: string[] = [];
if (!SHOPIFY_SHOP) missing.push('SHOPIFY_SHOP');
if (!SHOPIFY_ACCESS_TOKEN) missing.push('SHOPIFY_ACCESS_TOKEN');
if (!KLAVIYO_API_KEY) missing.push('KLAVIYO_API_KEY');
if (!KLAVIYO_LIST_ID) missing.push('KLAVIYO_LIST_ID');
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shopify GraphQL: paginate customers with the target tag
// ---------------------------------------------------------------------------

interface ShopifyCustomer {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  emailMarketingConsent: { marketingState: string } | null;
}

async function shopifyGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  if (body.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors).slice(0, 500)}`);
  }
  return body.data as T;
}

const CUSTOMERS_QUERY = `
  query ($cursor: String, $first: Int!, $query: String!) {
    customers(first: $first, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        email
        firstName
        lastName
        emailMarketingConsent { marketingState }
      }
    }
  }
`;

async function* fetchTaggedCustomers(): AsyncGenerator<ShopifyCustomer[]> {
  let cursor: string | null = null;
  let pageNum = 0;
  while (true) {
    if (pageNum >= PAGE_LIMIT) return;
    type CustomersPage = {
      customers: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyCustomer[] };
    };
    const data: CustomersPage = await shopifyGraphql<CustomersPage>(
      CUSTOMERS_QUERY,
      { cursor, first: SHOPIFY_PAGE_SIZE, query: `tag:${TAG}` }
    );
    pageNum++;
    yield data.customers.nodes;
    if (!data.customers.pageInfo.hasNextPage) return;
    cursor = data.customers.pageInfo.endCursor;
  }
}

// ---------------------------------------------------------------------------
// Klaviyo: bulk subscribe a batch of profiles
// ---------------------------------------------------------------------------

interface KlaviyoProfile {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

async function klaviyoBulkSubscribe(profiles: KlaviyoProfile[]): Promise<void> {
  if (!profiles.length) return;
  const res = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      revision: KLAVIYO_API_REVISION,
    },
    body: JSON.stringify({
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: {
          profiles: {
            data: profiles.map((p) => ({
              type: 'profile',
              attributes: {
                email: p.email,
                ...(p.firstName ? { first_name: p.firstName } : {}),
                ...(p.lastName ? { last_name: p.lastName } : {}),
                subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
              },
            })),
          },
        },
        relationships: { list: { data: { type: 'list', id: KLAVIYO_LIST_ID } } },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Klaviyo ${res.status}: ${body.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nBackfill Klaviyo from Shopify customers tagged "${TAG}"`);
  console.log(`Mode: ${APPLY ? 'APPLY (will subscribe)' : 'DRY RUN (no Klaviyo writes)'}`);
  console.log(`Page limit: ${PAGE_LIMIT === Infinity ? 'none' : PAGE_LIMIT}\n`);

  let totalSeen = 0;
  let totalEligible = 0;
  let totalSkippedNoEmail = 0;
  let totalSkippedUnsubscribed = 0;
  let totalSubscribed = 0;
  let pageNum = 0;
  let pendingBatch: KlaviyoProfile[] = [];

  async function flushBatch() {
    if (!pendingBatch.length) return;
    if (APPLY) {
      try {
        await klaviyoBulkSubscribe(pendingBatch);
        totalSubscribed += pendingBatch.length;
        console.log(`  Subscribed batch of ${pendingBatch.length} (total subscribed: ${totalSubscribed})`);
      } catch (err) {
        console.error(`  Batch failed: ${(err as Error).message}`);
      }
    } else {
      totalSubscribed += pendingBatch.length;
      console.log(`  [dry run] Would subscribe ${pendingBatch.length}: ${pendingBatch.slice(0, 3).map((p) => p.email).join(', ')}${pendingBatch.length > 3 ? ', …' : ''}`);
    }
    pendingBatch = [];
  }

  for await (const customers of fetchTaggedCustomers()) {
    pageNum++;
    totalSeen += customers.length;
    console.log(`Page ${pageNum}: ${customers.length} customers (running total: ${totalSeen})`);

    for (const c of customers) {
      if (!c.email) {
        totalSkippedNoEmail++;
        continue;
      }
      // Respect explicit unsubscribes — if Shopify says they unsubscribed
      // from marketing emails, don't push them back into Klaviyo.
      if (c.emailMarketingConsent?.marketingState === 'UNSUBSCRIBED') {
        totalSkippedUnsubscribed++;
        continue;
      }
      totalEligible++;
      pendingBatch.push({ email: c.email, firstName: c.firstName, lastName: c.lastName });
      if (pendingBatch.length >= KLAVIYO_BATCH_SIZE) {
        await flushBatch();
      }
    }
  }
  await flushBatch();

  console.log('\n--- Done ---');
  console.log(`Customers seen:        ${totalSeen}`);
  console.log(`Skipped (no email):    ${totalSkippedNoEmail}`);
  console.log(`Skipped (unsubscribed):${totalSkippedUnsubscribed}`);
  console.log(`Eligible:              ${totalEligible}`);
  console.log(`${APPLY ? 'Subscribed' : 'Would subscribe'}: ${totalSubscribed}`);
  if (!APPLY) {
    console.log('\nRe-run with --apply to actually subscribe these profiles.');
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
