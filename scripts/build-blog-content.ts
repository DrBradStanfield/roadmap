/**
 * Fetches all blog articles from Shopify Admin API, converts HTML to markdown,
 * and saves them to docs/blog/ for chatbot reference.
 *
 * Usage: npx tsx scripts/build-blog-content.ts
 * Requires: SHOPIFY_SHOP and SHOPIFY_ADMIN_ACCESS_TOKEN in .env
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import TurndownService from 'turndown';

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;
const BLOG_DIR = path.join(process.cwd(), 'docs/blog');
const BLOG_ID = 'gid://shopify/Blog/110605074717';
const PAGE_SIZE = 50; // Keep batch small to avoid huge responses

if (!SHOP || !TOKEN) {
  console.error('Error: Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_ACCESS_TOKEN in .env');
  process.exit(1);
}

interface Article {
  title: string;
  handle: string;
  tags: string[];
  publishedAt: string;
  body: string;
}

interface IndexEntry {
  title: string;
  handle: string;
  url: string;
  tags: string[];
  keywords: string[];
  publishedAt: string;
  type?: 'reference' | 'article';
}

// Health/supplement keywords to extract from content for better matching
const KEYWORD_PATTERNS = [
  'vitamin [a-ek]\\d?', 'vitamin d3?', 'vitamin b\\d+', 'folate', 'folic acid',
  'magnesium', 'zinc', 'selenium', 'iron', 'calcium', 'potassium', 'iodine', 'boron',
  'omega-?3', 'fish oil', 'epa', 'dha',
  'collagen', 'creatine', 'taurine', 'glycine', 'tmg', 'betaine', 'nad\\+?',
  'nmn', 'niacin', 'resveratrol', 'quercetin', 'curcumin', 'turmeric', 'berberine',
  'melatonin', 'ashwagandha', 'rhodiola', 'l-theanine',
  'hyaluronic acid', 'retinoid', 'retinol', 'tretinoin', 'sunscreen', 'spf',
  'psyllium', 'fiber', 'probiotic', 'prebiotic',
  'statin', 'metformin', 'rapamycin', 'ezetimibe', 'pcsk9', 'sglt2', 'glp-?1',
  'blood pressure', 'hypertension', 'cholesterol', 'ldl', 'hdl', 'triglycerides',
  'hba1c', 'blood sugar', 'diabetes', 'insulin resistance',
  'bmi', 'obesity', 'weight loss', 'intermittent fasting', 'caloric restriction',
  'egfr', 'kidney', 'creatinine',
  'colonoscopy', 'mammogram', 'dexa', 'bone density', 'osteoporosis',
  'prostate', 'psa', 'cervical', 'lung cancer', 'breast cancer', 'colon cancer',
  'heart attack', 'stroke', 'cardiovascular', 'atherosclerosis',
  'dementia', 'alzheimer', 'cognitive', 'brain health',
  'muscle', 'sarcopenia', 'exercise', 'strength training', 'resistance training',
  'sleep', 'insomnia', 'circadian',
  'aging', 'longevity', 'lifespan', 'healthspan', 'anti-aging',
  'mri', 'ct scan', 'ultrasound',
  'testosterone', 'trt', 'estrogen', 'hormone',
  'inflammation', 'antioxidant', 'oxidative stress',
  'gut health', 'microbiome',
  'skin', 'wrinkles', 'photoaging', 'uv',
  'bpc-?157', 'peptide', 'methylene blue',
  'alpha lipoic acid', 'ala', 'coq10',
  'seed oil', 'olive oil', 'mediterranean diet',
  'gout', 'uric acid',
];

const KEYWORD_REGEX = new RegExp(`\\b(${KEYWORD_PATTERNS.join('|')})\\b`, 'gi');

function extractKeywords(text: string): string[] {
  const matches = text.match(KEYWORD_REGEX) || [];
  const unique = new Set(matches.map(m => m.toLowerCase()));
  return [...unique].sort();
}

async function shopifyGraphQL(query: string): Promise<any> {
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': TOKEN!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  return res.json();
}

async function fetchAllArticles(): Promise<Article[]> {
  const articles: Article[] = [];
  let cursor: string | null = null;
  let page = 0;

  while (true) {
    page++;
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      blog(id: "${BLOG_ID}") {
        articles(first: ${PAGE_SIZE}${afterClause}, reverse: true) {
          edges {
            cursor
            node {
              title
              handle
              tags
              publishedAt
              body
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }`;

    console.log(`  Fetching page ${page}...`);
    const result = await shopifyGraphQL(query);
    if (result?.errors) console.error('GraphQL errors:', JSON.stringify(result.errors));
    const edges = result?.data?.blog?.articles?.edges ?? [];
    const hasNext = result?.data?.blog?.articles?.pageInfo?.hasNextPage;

    for (const { cursor: c, node } of edges) {
      articles.push(node);
      cursor = c;
    }

    if (!hasNext || edges.length === 0) break;
  }

  return articles;
}

function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });

  // Remove iframes (YouTube embeds, etc.)
  turndown.addRule('removeIframes', {
    filter: 'iframe',
    replacement: () => '',
  });

  // Remove images (Shopify CDN URLs aren't useful in text context)
  turndown.addRule('removeImages', {
    filter: 'img',
    replacement: () => '',
  });

  return turndown.turndown(html).trim();
}

async function main() {
  console.log('Fetching blog articles from Shopify...');
  const articles = await fetchAllArticles();
  console.log(`Fetched ${articles.length} articles.`);

  // Ensure output directory exists
  fs.mkdirSync(BLOG_DIR, { recursive: true });

  // Preserve `type` field from existing index (Shopify doesn't store it)
  const existingTypeMap = new Map<string, 'reference' | 'article'>();
  try {
    const oldIndex: IndexEntry[] = JSON.parse(
      fs.readFileSync(path.join(BLOG_DIR, 'index.json'), 'utf-8'),
    );
    for (const entry of oldIndex) {
      if (entry.type) existingTypeMap.set(entry.handle, entry.type);
    }
    if (existingTypeMap.size > 0) {
      console.log(`Preserving 'type' field for ${existingTypeMap.size} entries from existing index.`);
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  // Note: We no longer delete existing .md files before rebuilding.
  // Reference articles (type: "reference") are created by /reference-post
  // and would be lost if deleted here, since they don't come from Shopify.
  // Instead, we overwrite only the files fetched from Shopify.

  const index: IndexEntry[] = [];

  for (const article of articles) {
    const markdown = htmlToMarkdown(article.body);
    const keywords = extractKeywords(markdown);
    const url = `https://drstanfield.com/blogs/articles/${article.handle}`;

    // Write .md file with frontmatter
    const content = `---
title: "${article.title.replace(/"/g, '\\"')}"
url: "${url}"
publishedAt: "${article.publishedAt}"
tags: ${JSON.stringify(article.tags)}
keywords: ${JSON.stringify(keywords)}
---

${markdown}
`;
    fs.writeFileSync(path.join(BLOG_DIR, `${article.handle}.md`), content);

    // Add to index (preserve type from previous index if set)
    const entry: IndexEntry = {
      title: article.title,
      handle: article.handle,
      url,
      tags: article.tags,
      keywords,
      publishedAt: article.publishedAt,
    };
    const preservedType = existingTypeMap.get(article.handle);
    if (preservedType) entry.type = preservedType;
    index.push(entry);
  }

  // Write index.json
  fs.writeFileSync(
    path.join(BLOG_DIR, 'index.json'),
    JSON.stringify(index, null, 2),
  );

  console.log(`\nDone! Wrote ${articles.length} articles to docs/blog/`);
  console.log(`Index: docs/blog/index.json`);

  // Stats
  const totalKeywords = new Set(index.flatMap(a => a.keywords));
  console.log(`Unique keywords across all articles: ${totalKeywords.size}`);
  const avgKeywords = index.reduce((sum, a) => sum + a.keywords.length, 0) / index.length;
  console.log(`Average keywords per article: ${avgKeywords.toFixed(1)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
