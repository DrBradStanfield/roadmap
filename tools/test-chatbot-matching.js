#!/usr/bin/env node

/**
 * Chatbot matching test harness.
 *
 * Runs a set of realistic user queries through the `matchBlogArticles` logic
 * and reports pass/fail against expected pathway/article handles.
 *
 * The matching logic here is a **replica** of `matchBlogArticles()` in
 * `app/lib/chat.server.ts`. Keep them in sync when either changes. The app
 * code is the primary source of truth; this harness is the test oracle.
 *
 * Usage:
 *   node tools/test-chatbot-matching.js
 *   node tools/test-chatbot-matching.js --with-synonyms
 *   node tools/test-chatbot-matching.js --verbose
 *   node tools/test-chatbot-matching.js --category cardiovascular
 *
 * Exit code 0 if all pass, 1 otherwise.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const withSynonyms = args.includes('--with-synonyms');
const verbose = args.includes('--verbose');
const catIdx = args.indexOf('--category');
const categoryFilter = catIdx >= 0 ? args[catIdx + 1] : null;

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(REPO_ROOT, 'docs/blog/index.json');
const QUERIES_PATH = path.join(__dirname, 'test-queries.json');

const BLOG_INDEX = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
const TEST_QUERIES = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf-8'));

// Load synonym map if flag is set
let SYNONYM_SETS = [];
if (withSynonyms) {
  const synPath = path.join(REPO_ROOT, 'app/lib/synonyms.ts');
  try {
    const src = fs.readFileSync(synPath, 'utf-8');
    // Extract array literal assigned to SYNONYM_SETS
    const m = src.match(/SYNONYM_SETS[^=]*=\s*(\[[\s\S]*?\n\]);/);
    if (m) {
      // eslint-disable-next-line no-eval
      SYNONYM_SETS = eval(m[1]);
    } else {
      console.warn('Could not parse SYNONYM_SETS from synonyms.ts');
    }
  } catch (e) {
    console.warn(`synonyms.ts not found at ${synPath} — running without expansion`);
  }
}

// ---------------------------------------------------------------------------
// Query expansion via synonym equivalence sets
// ---------------------------------------------------------------------------

function expandQuery(msg) {
  if (!SYNONYM_SETS.length) return msg;
  const msgLower = msg.toLowerCase();
  const additions = [];

  // For short terms (≤4 chars), require word boundaries to avoid "ed" matching
  // the suffix of "gained", "mi" matching "minimum", etc. For longer terms,
  // substring matching is fine.
  const matchTerm = (term) => {
    const t = term.toLowerCase();
    if (t.length <= 4) {
      return new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(msgLower);
    }
    return msgLower.includes(t);
  };

  for (const set of SYNONYM_SETS) {
    const matched = set.find(matchTerm);
    if (matched) {
      for (const other of set) {
        if (other !== matched) additions.push(other);
      }
    }
  }
  return additions.length > 0 ? msg + ' ' + additions.join(' ') : msg;
}

// ---------------------------------------------------------------------------
// matchBlogArticles — replica of chat.server.ts logic
// ---------------------------------------------------------------------------

function matchBlogArticles(userMessage, maxResults = 3) {
  if (BLOG_INDEX.length === 0) return [];
  const msgLower = userMessage.toLowerCase();
  const matches = [];

  for (const article of BLOG_INDEX) {
    let score = 0;

    for (const kw of article.keywords || []) {
      if (msgLower.includes(kw.toLowerCase())) score += 2;
    }
    for (const tag of article.tags || []) {
      if (msgLower.includes(tag.toLowerCase())) score += 1;
    }
    const titleWords = article.title.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    for (const word of titleWords) {
      if (msgLower.includes(word)) score += 1;
    }

    if ((article.type === 'guideline' || article.type === 'pathway') && score > 0) score += 8;
    else if (article.type === 'reference' && score > 0) score += 5;

    if (score > 2) {
      matches.push({ handle: article.handle, score, type: article.type || 'article' });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Run tests
// ---------------------------------------------------------------------------

const filtered = categoryFilter
  ? TEST_QUERIES.filter(q => q.category === categoryFilter)
  : TEST_QUERIES;

if (filtered.length === 0) {
  console.error(`No queries match category "${categoryFilter}"`);
  process.exit(1);
}

const pass = [];
const fail = [];
const byCategory = {};

for (const q of filtered) {
  const expandedQuery = expandQuery(q.query);
  const top = matchBlogArticles(expandedQuery, 3);
  const topHandles = top.map(m => m.handle);

  // If expected is [] (empty), the test passes if no match is returned
  // (or if the top match has no "obvious" false-positive handle)
  let passed;
  if (q.expected.length === 0) {
    // For ambiguous queries, we just log what was matched and treat as "review"
    passed = top.length === 0;
  } else {
    passed = q.expected.some(e => topHandles.includes(e));
  }

  const entry = { ...q, expandedQuery, topHandles, top, passed };
  (passed ? pass : fail).push(entry);

  byCategory[q.category] = byCategory[q.category] || { pass: 0, fail: 0 };
  byCategory[q.category][passed ? 'pass' : 'fail']++;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GREY = '\x1b[90m';
const RESET = '\x1b[0m';

console.log(`\n${BOLD}=== Chatbot Matching Test Results ===${RESET}\n`);
console.log(`Synonyms:     ${withSynonyms ? `${GREEN}ENABLED${RESET} (${SYNONYM_SETS.length} sets)` : `${GREY}disabled${RESET}`}`);
console.log(`Total:        ${filtered.length}`);
console.log(`${GREEN}Passing:      ${pass.length}${RESET}`);
console.log(`${RED}Failing:      ${fail.length}${RESET}`);
console.log(`Pass rate:    ${BOLD}${(pass.length / filtered.length * 100).toFixed(1)}%${RESET}\n`);

console.log(`${BOLD}--- By category ---${RESET}`);
const sortedCats = Object.entries(byCategory).sort((a, b) => b[1].fail - a[1].fail);
for (const [cat, stats] of sortedCats) {
  const total = stats.pass + stats.fail;
  const rate = (stats.pass / total * 100).toFixed(0);
  const colour = stats.fail === 0 ? GREEN : (stats.pass === 0 ? RED : '');
  console.log(`  ${colour}${cat.padEnd(20)} ${stats.pass}/${total} (${rate}%)${RESET}`);
}

if (fail.length > 0) {
  console.log(`\n${BOLD}${RED}--- Failing queries ---${RESET}`);
  for (const r of fail) {
    console.log(`\n${RED}✗${RESET} ${BOLD}[${r.category}]${RESET} "${r.query}"`);
    if (r.expected.length > 0) {
      console.log(`    Expected: ${r.expected.join(' | ')}`);
    } else {
      console.log(`    Expected: (no match — ambiguous query)`);
    }
    if (r.top.length === 0) {
      console.log(`    Got:      ${GREY}(nothing matched above threshold)${RESET}`);
    } else {
      console.log(`    Got top:  ${r.top.map(t => `${t.handle} [${t.score}]`).join(', ')}`);
    }
    if (r.notes) console.log(`    ${GREY}${r.notes}${RESET}`);
  }
}

if (verbose) {
  console.log(`\n${BOLD}${GREEN}--- Passing queries ---${RESET}`);
  for (const r of pass) {
    const first = r.topHandles[0] || '(none)';
    console.log(`${GREEN}✓${RESET} [${r.category}] "${r.query}" → ${first}`);
  }
}

console.log();
process.exit(fail.length > 0 ? 1 : 0);