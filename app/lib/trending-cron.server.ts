/**
 * Trending blog articles cron job.
 *
 * Once per day, queries Shopify Admin (ShopifyQL) for landing-page `sessions`
 * over the last 7 days and the prior baseline window. Computes a fold-change
 * ratio (current_7d / baseline_weekly) per article, filters by age + view
 * floors, and writes the top 5 to the `health_roadmap.trending_articles` shop
 * metafield.
 *
 * The storefront (Liquid section blog-newspaper-header) reads the metafield
 * to render a "Trending" sidebar.
 *
 * Mirrors the architecture of reminder-cron.server.ts: setInterval at hourly
 * cadence, processes on first tick ≥ TARGET_HOUR_NZ, distributed lock via Supabase.
 */
import * as Sentry from '@sentry/react-router';
import { unauthenticated } from '../shopify.server';
import { tryAcquireCronLock, type CronLockName } from './supabase.server';
import { loadBlogIndex, type BlogIndexEntry } from './blog-index.server';
import { withTimeout, nzNowParts } from './cron-helpers.server';

const CRON_INTERVAL_MS = 60 * 60 * 1000;
// 3am NZ. DST-aware via nzNowParts (Pacific/Auckland through Intl) and
// lock_date is NZ-local so the day boundary matches NZ midnight, not UTC.
const TARGET_HOUR_NZ = 3;
const MACHINE_ID = process.env.FLY_MACHINE_ID || `local-${process.pid}`;
const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || 'microvitamin.myshopify.com';

// The education store runs as a SEPARATE Fly app (`health-tool-edu`) from the
// SAME codebase, but it SHARES this app's Supabase project. So both apps' crons
// contend for the same `cron_lock` rows. Each store therefore needs its OWN
// trending lock, or only one store's metafield gets written per day (whichever
// machine wins the shared lock). The lock name is selected by shop domain; the
// edu store's lock row is seeded in supabase/rls-policies.sql.
const EDU_SHOP_DOMAIN = 'sz5utw-1r.myshopify.com';
const TRENDING_LOCK_NAME: CronLockName =
  SHOP_DOMAIN === EDU_SHOP_DOMAIN ? 'trending_cron_edu' : 'trending_cron';

// Articles younger than this are dropped — they don't have a clean baseline
// window. Must be >= the leading edge of QUERY_PRIOR_BASELINE (-45d), otherwise
// the baseline window extends past the article's publication date and the
// ratio is inflated by zero-traffic days.
const MIN_ARTICLE_AGE_DAYS = 45;
const MIN_CURRENT_7D_VIEWS = 50;
// Bumped from 10: shorter 37d window gives each low-traffic day more weight.
const MIN_BASELINE_WEEKLY_VIEWS = 12;
const TOP_N = 5;
// Baseline window length in days. Must match the SINCE/UNTIL range of
// QUERY_PRIOR_BASELINE or the per-week rate calculation drifts.
const BASELINE_WINDOW_DAYS = 37;

const ARTICLE_URL_RE = /^\/(?:[a-z-]+\/)?blogs\/articles\/([\w-]+)\/?$/;

// Offset by 1 day on the leading edge to allow for Shopify analytics data lag (24-48h typical)
// `sessions` is the only dataset in 2025-10 Admin API ShopifyQL with URL-level data.
// `sessions` is also the named metric (ShopifyQL doesn't use count() — metrics are
// pre-aggregated names). Grouping by landing_page_path counts sessions that entered
// the site at each URL. For blog articles, most traffic is external (search/social)
// so landing-page sessions is a reasonable trending proxy.
const QUERY_LAST_7D =
  'FROM sessions SHOW sessions GROUP BY landing_page_path SINCE -8d UNTIL -1d ORDER BY sessions DESC LIMIT 500';
const QUERY_PRIOR_BASELINE =
  'FROM sessions SHOW sessions GROUP BY landing_page_path SINCE -45d UNTIL -9d ORDER BY sessions DESC LIMIT 500';

const METAFIELD_NAMESPACE = 'health_roadmap';
const METAFIELD_KEY = 'trending_articles';

let lastRunDate: string | null = null;
let cronIntervalId: ReturnType<typeof setInterval> | null = null;

export function startTrendingCron(): void {
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    console.log(`Trending cron disabled in ${process.env.NODE_ENV}`);
    return;
  }

  console.log(`Trending cron started (will run on first tick ≥ ${TARGET_HOUR_NZ}:00 NZ daily, machine: ${MACHINE_ID}, shop: ${SHOP_DOMAIN}, lock: ${TRENDING_LOCK_NAME})`);

  cronIntervalId = setInterval(async () => {
    try {
      const now = new Date();
      const { hour: nzHour, dateStr: todayStr } = nzNowParts(now);
      // Run on the first tick at or after 3am NZ each day. Using `<` instead of
      // `!==` makes the cron resilient to deploys: if a restart shifts the
      // setInterval offset past the target hour, the next tick still fires
      // today via the lock guard, rather than waiting 24 hours. todayStr is
      // NZ-local date so the day boundary matches NZ midnight.
      if (nzHour < TARGET_HOUR_NZ) return;

      if (lastRunDate === todayStr) return;

      const acquired = await tryAcquireCronLock(MACHINE_ID, todayStr, TRENDING_LOCK_NAME);
      if (!acquired) {
        lastRunDate = todayStr;
        return;
      }

      lastRunDate = todayStr;

      console.log(`Trending cron: starting daily processing (machine: ${MACHINE_ID})`);
      const ranked = await computeAndWriteTrending();
      console.log(`Trending cron: completed, wrote ${ranked.length} entries`);
    } catch (error) {
      console.error('Trending cron error:', error);
      Sentry.captureException(error, { tags: { feature: 'trending_cron' } });
    }
  }, CRON_INTERVAL_MS);
}

export function stopTrendingCron(): void {
  if (cronIntervalId) {
    clearInterval(cronIntervalId);
    cronIntervalId = null;
    console.log('Trending cron stopped');
  }
}

interface UrlViewRow {
  url: string;
  views: number;
}

/** Throw if the Shopify admin GraphQL response carries top-level `errors`.
 *  Without this, response shapes like `{ errors: [...], data: null }` slip
 *  past userErrors checks and the cron silently no-ops. */
function assertNoTopLevelErrors(body: any, context: string): void {
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    throw new Error(`${context}: top-level GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
}

async function runShopifyQL(admin: any, query: string): Promise<UrlViewRow[]> {
  const result = await admin.graphql(
    `query RunShopifyQL($query: String!) {
      shopifyqlQuery(query: $query) {
        parseErrors
        tableData {
          columns { name dataType }
          rows
        }
      }
    }`,
    { variables: { query } },
  );

  const body = await result.json();
  assertNoTopLevelErrors(body, 'runShopifyQL');
  const node = body.data?.shopifyqlQuery;

  if (!node) {
    throw new Error(`ShopifyQL returned no data: ${JSON.stringify(body)}`);
  }
  if (Array.isArray(node.parseErrors) && node.parseErrors.length > 0) {
    throw new Error(`ShopifyQL parse error: ${JSON.stringify(node.parseErrors)}`);
  }
  if (!node.tableData) {
    throw new Error(`ShopifyQL returned no tableData: ${JSON.stringify(node)}`);
  }

  const columns: { name: string }[] = node.tableData.columns ?? [];
  if (!columns.some(c => c.name === 'landing_page_path') ||
      !columns.some(c => c.name === 'sessions')) {
    throw new Error(`ShopifyQL columns missing landing_page_path/sessions: ${JSON.stringify(columns)}`);
  }

  // Rows come back as objects keyed by column name, e.g.
  //   { landing_page_path: "/blogs/articles/foo", sessions: "419" }
  // Note: `sessions` is returned as a string even though the column dataType is INTEGER.
  const rawRows = node.tableData.rows;
  const rows: UrlViewRow[] = [];
  if (Array.isArray(rawRows)) {
    for (const row of rawRows) {
      if (!row || typeof row !== 'object') continue;
      const url = String((row as any).landing_page_path ?? '');
      const views = Number((row as any).sessions ?? 0);
      if (url && Number.isFinite(views)) rows.push({ url, views });
    }
  }
  return rows;
}

async function getShopId(admin: any): Promise<string> {
  const result = await admin.graphql(`query { shop { id } }`);
  const body = await result.json();
  assertNoTopLevelErrors(body, 'getShopId');
  const id = body.data?.shop?.id;
  if (!id) throw new Error(`getShopId: missing shop.id in response: ${JSON.stringify(body)}`);
  return id;
}

/** Exported for unit tests. */
export async function writeTrendingMetafield(
  admin: any,
  shopId: string,
  entries: { handle: string; score: number }[],
): Promise<void> {
  const value = JSON.stringify(entries);
  const result = await admin.graphql(
    `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace value updatedAt }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        metafields: [{
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          ownerId: shopId,
          type: 'json',
          value,
        }],
      },
    },
  );
  const body = await result.json();
  assertNoTopLevelErrors(body, 'writeTrendingMetafield');

  const node = body.data?.metafieldsSet;
  if (!node) {
    throw new Error(`Metafield write returned no data node: ${JSON.stringify(body)}`);
  }

  const userErrors = node.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(`Metafield write userErrors: ${JSON.stringify(userErrors)}`);
  }

  // Verify the mutation actually returned the written metafield — proves the
  // write committed, not just that the request didn't error.
  const written = node.metafields ?? [];
  if (written.length === 0) {
    throw new Error(`Metafield write returned empty metafields array (no row written): ${JSON.stringify(body)}`);
  }

  // Commit check: assert the record Shopify echoed back carries the value we
  // submitted. This catches the silent-failure mode (Shopify echoes the
  // existing record with the OLD value — nothing committed) without the false
  // alarm of the previous updatedAt-freshness guard: `metafieldsSet` is
  // idempotent, so submitting a value identical to the stored one is a
  // successful no-op that legitimately returns the OLD updatedAt (the
  // "Metafield write returned stale updatedAt" Sentry noise, daily whenever
  // the trending list didn't change — e.g. `[]` over `[]`).
  const echoed = String(written[0].value ?? '');
  // Tolerate JSON whitespace normalization by Shopify (value is compact
  // JSON.stringify output, so re-stringifying the echo normalizes both sides).
  let normalizedEcho: string;
  try { normalizedEcho = JSON.stringify(JSON.parse(echoed)); } catch { normalizedEcho = echoed; }
  if (normalizedEcho !== value) {
    throw new Error(
      `Metafield write echoed a different value than submitted — nothing committed. ` +
      `Submitted: ${value} Echoed: ${echoed.slice(0, 500)}`,
    );
  }
  console.log(`Trending: metafield written (id=${written[0].id}, updatedAt=${written[0].updatedAt})`);
}

interface TrendingEntry {
  handle: string;
  score: number;
  current7d: number;
  baselineWeekly: number;
}

/** How a traffic handle resolves for one store: which blog-index entry it
 *  belongs to, and the handle that store actually serves the article under
 *  (= what goes in the metafield so the store's Liquid `articles[...]` lookup
 *  resolves). */
export interface StoreHandle {
  storeHandle: string;
  entry: BlogIndexEntry;
}

/** Extract the article handle from a full blog-post URL, or null. */
function handleFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const match = new URL(url).pathname.match(ARTICLE_URL_RE);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Key the blog index by every handle the given store's traffic can appear
 * under. The two stores publish the same articles under DIFFERENT handles:
 * the index `handle` is the drstanfield.com (education) handle; the
 * microvitamin.com (commerce) handle only exists inside `commerceUrl`.
 *
 * Commerce store: key by the commerce handle, and ALSO alias the education
 * handle to the same entry — until the 2026-06-24 domain split,
 * drstanfield.com pointed at the commerce store, so that store's baseline
 * sessions live under the education handles. Without the alias every article
 * fails a view floor on one side of the split and the trending list is
 * permanently `[]` (the bug that emptied the microvitamin.com sidebar).
 * Entries with no `commerceUrl` don't exist on the commerce store and are
 * excluded.
 */
export function buildStoreHandleMap(
  entries: BlogIndexEntry[],
  shopDomain: string,
): Map<string, StoreHandle> {
  const map = new Map<string, StoreHandle>();
  for (const entry of entries) {
    if (shopDomain === EDU_SHOP_DOMAIN) {
      map.set(entry.handle, { storeHandle: entry.handle, entry });
      continue;
    }
    const commerceHandle = handleFromUrl(entry.commerceUrl);
    if (!commerceHandle) continue;
    map.set(commerceHandle, { storeHandle: commerceHandle, entry });
    // Alias, not overwrite: another entry's own handle wins over this alias.
    if (!map.has(entry.handle)) {
      map.set(entry.handle, { storeHandle: commerceHandle, entry });
    }
  }
  return map;
}

/** Sum views per store handle, resolving traffic handles (and locale-prefixed
 *  URLs) through the store's handle map. */
function aggregateByStoreHandle(
  rows: UrlViewRow[],
  handleMap: Map<string, StoreHandle>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const { url, views } of rows) {
    let pathname: string;
    try {
      pathname = url.startsWith('http') ? new URL(url).pathname : url;
    } catch {
      continue;
    }
    const match = pathname.match(ARTICLE_URL_RE);
    if (!match) continue;
    const resolved = handleMap.get(match[1]);
    if (!resolved) continue;
    totals.set(resolved.storeHandle, (totals.get(resolved.storeHandle) ?? 0) + views);
  }
  return totals;
}

/** Pure function — accepts pre-fetched data so it's testable without network.
 *  `handleMap` comes from `buildStoreHandleMap` for the target store. */
export function computeTrending(
  current7dRows: UrlViewRow[],
  priorBaselineRows: UrlViewRow[],
  handleMap: Map<string, StoreHandle>,
  now: Date = new Date(),
): TrendingEntry[] {
  const current7dByHandle = aggregateByStoreHandle(current7dRows, handleMap);
  const priorBaselineByHandle = aggregateByStoreHandle(priorBaselineRows, handleMap);

  const minPublishedAt = new Date(now.getTime() - MIN_ARTICLE_AGE_DAYS * 86400 * 1000);

  const candidates: TrendingEntry[] = [];

  for (const [handle, current7d] of current7dByHandle) {
    if (current7d < MIN_CURRENT_7D_VIEWS) continue;

    const meta = handleMap.get(handle)?.entry;
    if (!meta) continue;

    const publishedAt = new Date(meta.publishedAt);
    if (Number.isNaN(publishedAt.getTime())) continue;
    if (publishedAt > minPublishedAt) continue;

    const baselineSessions = priorBaselineByHandle.get(handle) ?? 0;
    const baselineWeekly = (baselineSessions / BASELINE_WINDOW_DAYS) * 7;
    if (baselineWeekly < MIN_BASELINE_WEEKLY_VIEWS) continue;

    const score = current7d / baselineWeekly;
    candidates.push({ handle, score, current7d, baselineWeekly });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, TOP_N);
}

/** Run the full algorithm and write the metafield. Exported for the manual-trigger test route. */
export async function computeAndWriteTrending(): Promise<TrendingEntry[]> {
  const session = await withTimeout(
    unauthenticated.admin(SHOP_DOMAIN),
    15_000,
    'unauthenticated.admin',
  );
  if (!session?.admin) {
    throw new Error(`unauthenticated.admin(${SHOP_DOMAIN}) returned no admin client`);
  }
  const { admin } = session;

  const [current7dRows, priorBaselineRows, shopId] = await withTimeout(
    Promise.all([
      runShopifyQL(admin, QUERY_LAST_7D),
      runShopifyQL(admin, QUERY_PRIOR_BASELINE),
      getShopId(admin),
    ]),
    30_000,
    'shopifyQL+getShopId',
  );
  console.log(
    `Trending: fetched ${current7dRows.length} 7d rows, ${priorBaselineRows.length} baseline rows, shop=${shopId}`,
  );

  const handleMap = buildStoreHandleMap(loadBlogIndex(), SHOP_DOMAIN);
  const ranked = computeTrending(current7dRows, priorBaselineRows, handleMap);
  console.log(`Trending: ranked ${ranked.length} candidates (TOP_N=${TOP_N})`);

  for (const entry of ranked) {
    console.log(
      `Trending: ${entry.handle} score=${entry.score.toFixed(2)} ` +
      `current7d=${entry.current7d} baselineWeekly=${entry.baselineWeekly.toFixed(1)}`,
    );
  }

  const payload = ranked.map(e => ({ handle: e.handle, score: Number(e.score.toFixed(2)) }));
  await withTimeout(writeTrendingMetafield(admin, shopId, payload), 30_000, 'writeTrendingMetafield');

  return ranked;
}

startTrendingCron();
