/**
 * Trending blog articles cron job.
 *
 * Once per day, queries Shopify Admin (ShopifyQL) for `online_store_page_views`
 * over the last 7 days and the prior ~60 days. Computes a fold-change ratio
 * (current_7d / baseline_weekly) per article, filters by age + view floors,
 * and writes the top 5 to the `health_roadmap.trending_articles` shop metafield.
 *
 * The storefront (Liquid section blog-newspaper-header) reads the metafield
 * to render a "Trending" sidebar.
 *
 * Mirrors the architecture of reminder-cron.server.ts: setInterval at hourly
 * cadence, processes only at TARGET_HOUR_UTC, distributed lock via Supabase.
 */
import * as Sentry from '@sentry/remix';
import { unauthenticated } from '../shopify.server';
import { tryAcquireCronLock } from './supabase.server';
import { loadBlogIndex, type BlogIndexEntry } from './blog-index.server';

const CRON_INTERVAL_MS = 60 * 60 * 1000;
const TARGET_HOUR_UTC = 3;
const MACHINE_ID = process.env.FLY_MACHINE_ID || `local-${process.pid}`;
const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || 'microvitamin.myshopify.com';

const MIN_ARTICLE_AGE_DAYS = 60;
const MIN_CURRENT_7D_VIEWS = 50;
const MIN_BASELINE_WEEKLY_VIEWS = 10;
const TOP_N = 5;
// Baseline window length in days. Must match the SINCE/UNTIL range of QUERY_PRIOR_60D
// or the per-week rate calculation drifts.
const BASELINE_WINDOW_DAYS = 60;

const ARTICLE_URL_RE = /^\/(?:[a-z-]+\/)?blogs\/articles\/([\w-]+)\/?$/;

// Offset by 1 day on the leading edge to allow for Shopify analytics data lag (24-48h typical)
// `sessions` is the only dataset in 2025-10 Admin API ShopifyQL with URL-level data.
// `sessions` is also the named metric (ShopifyQL doesn't use count() — metrics are
// pre-aggregated names). Grouping by landing_page_path counts sessions that entered
// the site at each URL. For blog articles, most traffic is external (search/social)
// so landing-page sessions is a reasonable trending proxy.
const QUERY_LAST_7D =
  'FROM sessions SHOW sessions GROUP BY landing_page_path SINCE -8d UNTIL -1d ORDER BY sessions DESC LIMIT 500';
const QUERY_PRIOR_60D =
  'FROM sessions SHOW sessions GROUP BY landing_page_path SINCE -68d UNTIL -9d ORDER BY sessions DESC LIMIT 500';

const METAFIELD_NAMESPACE = 'health_roadmap';
const METAFIELD_KEY = 'trending_articles';

let lastRunDate: string | null = null;
let cronIntervalId: ReturnType<typeof setInterval> | null = null;

export function startTrendingCron(): void {
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    console.log(`Trending cron disabled in ${process.env.NODE_ENV}`);
    return;
  }

  console.log(`Trending cron started (will run at ${TARGET_HOUR_UTC}:00 UTC daily, machine: ${MACHINE_ID})`);

  cronIntervalId = setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() !== TARGET_HOUR_UTC) return;

    const todayStr = now.toISOString().slice(0, 10);
    if (lastRunDate === todayStr) return;

    const acquired = await tryAcquireCronLock(MACHINE_ID, todayStr, 'trending_cron');
    if (!acquired) {
      lastRunDate = todayStr;
      return;
    }

    lastRunDate = todayStr;

    try {
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
  return (await result.json()).data.shop.id;
}

async function writeTrendingMetafield(
  admin: any,
  shopId: string,
  entries: { handle: string; score: number }[],
): Promise<void> {
  const result = await admin.graphql(
    `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [{
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          ownerId: shopId,
          type: 'json',
          value: JSON.stringify(entries),
        }],
      },
    },
  );
  const body = await result.json();
  const userErrors = body.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(`Metafield write failed: ${JSON.stringify(userErrors)}`);
  }
}

interface TrendingEntry {
  handle: string;
  score: number;
  current7d: number;
  baselineWeekly: number;
}

function aggregateByHandle(rows: UrlViewRow[]): Map<string, number> {
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
    const handle = match[1];
    totals.set(handle, (totals.get(handle) ?? 0) + views);
  }
  return totals;
}

/** Pure function — accepts pre-fetched data so it's testable without network. */
export function computeTrending(
  current7dRows: UrlViewRow[],
  prior60dRows: UrlViewRow[],
  blogIndex: Map<string, BlogIndexEntry>,
  now: Date = new Date(),
): TrendingEntry[] {
  const current7dByHandle = aggregateByHandle(current7dRows);
  const prior60dByHandle = aggregateByHandle(prior60dRows);

  const minPublishedAt = new Date(now.getTime() - MIN_ARTICLE_AGE_DAYS * 86400 * 1000);

  const candidates: TrendingEntry[] = [];

  for (const [handle, current7d] of current7dByHandle) {
    if (current7d < MIN_CURRENT_7D_VIEWS) continue;

    const meta = blogIndex.get(handle);
    if (!meta) continue;

    const publishedAt = new Date(meta.publishedAt);
    if (Number.isNaN(publishedAt.getTime())) continue;
    if (publishedAt > minPublishedAt) continue;

    const baseline60d = prior60dByHandle.get(handle) ?? 0;
    const baselineWeekly = (baseline60d / BASELINE_WINDOW_DAYS) * 7;
    if (baselineWeekly < MIN_BASELINE_WEEKLY_VIEWS) continue;

    const score = current7d / baselineWeekly;
    candidates.push({ handle, score, current7d, baselineWeekly });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, TOP_N);
}

/** Run the full algorithm and write the metafield. Exported for the manual-trigger test route. */
export async function computeAndWriteTrending(): Promise<TrendingEntry[]> {
  const { admin } = await unauthenticated.admin(SHOP_DOMAIN);

  const [current7dRows, prior60dRows, shopId] = await Promise.all([
    runShopifyQL(admin, QUERY_LAST_7D),
    runShopifyQL(admin, QUERY_PRIOR_60D),
    getShopId(admin),
  ]);

  const blogIndex = new Map<string, BlogIndexEntry>(
    loadBlogIndex().map(entry => [entry.handle, entry]),
  );
  const ranked = computeTrending(current7dRows, prior60dRows, blogIndex);

  for (const entry of ranked) {
    console.log(
      `Trending: ${entry.handle} score=${entry.score.toFixed(2)} ` +
      `current7d=${entry.current7d} baselineWeekly=${entry.baselineWeekly.toFixed(1)}`,
    );
  }

  const payload = ranked.map(e => ({ handle: e.handle, score: Number(e.score.toFixed(2)) }));
  await writeTrendingMetafield(admin, shopId, payload);

  return ranked;
}

startTrendingCron();
