# Chatbot Architecture

Technical reference for how the Health Roadmap Assistant finds and delivers relevant content in response to a user query. Sister documents:

- [`chat-feature.md`](./chat-feature.md) — user-facing behavior, scope, access rules, UI, billing
- [`../../../Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/docs/chat-knowledge-map.md`](../../../Library/CloudStorage/Dropbox/YouTube/multivitamin%20&%20others/claude_business/docs/chat-knowledge-map.md) — clinical content strategy (what content we build and why)

---

## End-to-end flow

```
┌─────────────────┐
│  User types     │  e.g. "I'm tired and gaining weight"
│  a query        │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│  expandQuery()                              │
│  synonyms.ts — equivalence sets             │
│  "T2DM" → add "type 2 diabetes", "t2d"      │
│  Word boundaries for short terms (≤4 chars) │
└────────┬────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│  matchBlogArticles()                        │
│  Score each of 991 index entries:           │
│    +2 per keyword substring match           │
│    +1 per tag match                         │
│    +1 per title word match (4+ chars)       │
│    +8 if pathway or guideline               │
│    +5 if reference article                  │
│  Threshold: score > 2                       │
│  Return: top 3 handles                      │
└────────┬────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│  loadBlogArticle() × top 3                  │
│  Path by type:                              │
│    pathway   → docs/pathway/{slug}.md       │
│    guideline → docs/guideline/{slug}.md     │
│    reference → docs/blog/{slug}.md          │
│    article   → docs/blog/{slug}.md          │
│  Cached in memory after first read          │
└────────┬────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│  buildSystemBlocks()                        │
│  Injects matched content as a system block  │
│  (uncached — per-request)                   │
└────────┬────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│  Anthropic API — Haiku 4.5                  │
│  Cached blocks (system prompt, algorithm,   │
│  evidence, products, knowledge overview)    │
│  + User health data + matched content       │
│  + conversation history + user message      │
└────────┬────────────────────────────────────┘
         │
         ▼
   Response to user
```

Every step is described in detail below.

---

## Content model

The chatbot has access to **991 content entries** across four types:

| Type | Count | Location | What it is | Score boost |
|---|---|---|---|---|
| **pathway** | 710 | `docs/pathway/*.md` | Clinical pathways from Auckland Region HealthPathways. Cover symptoms, red flags, investigations, management. | +8 |
| **guideline** | 3 | `docs/guideline/*.md` | AHA/WHO/AASM-based guidance on diet, exercise, sleep. Each section is "Guideline position / Brad's position / References". | +8 |
| **reference** | 113 | `docs/blog/*.md` | Standalone supplement/nutrient articles (vitamin D, omega-3, creatine, etc.). | +5 |
| **article** | 165 | `docs/blog/*.md` | Dr Stanfield's YouTube video blog posts. | +0 |

### Two pathway subtypes — CRITICAL

Within the 710 pathway entries, there are two distinct design patterns:

1. **Condition pathways** (e.g., `hypothyroidism`, `hypertension-in-adults`, `type-2-diabetes`) — authored for users/clinicians who already know the diagnosis. Keywords are clinical terms specific to that condition.

2. **Symptom pathways** — **59 of these** (e.g., `fatigue`, `chest-pain`, `acute-abdominal-pain-in-adults`, `weight-related-concerns-in-adults`, `headaches-in-adults`, `dyspnoea`, `palpitations-*`, etc.) — authored for *undifferentiated symptom presentations*. Walk through the differential diagnosis, red flags, and investigations.

**Routing rule:**

| User query type | Example | Correct pathway | Why |
|---|---|---|---|
| Diagnostic (names a condition) | "What should I do about my hypothyroidism?" | `hypothyroidism` | User knows the diagnosis — load condition-specific content |
| Symptomatic (describes symptoms) | "I'm tired and gaining weight" | `fatigue` | Differential-aware pathway — loads content that considers thyroid, anaemia, depression, sleep apnoea, cancer, etc. |

**Why this matters clinically**: routing a symptom query to a specific diagnosis pathway (e.g., "tired + gaining weight" → `hypothyroidism`) is a clinical safety regression. The patient may have anaemia, depression, sleep apnoea, or something else. The symptom pathway contains the full differential; it IS the differential layer. No LLM differential pre-call is needed.

**Keyword placement rule**: lay-term symptom keywords go on **symptom pathways**, not on specific-diagnosis pathways. "Weight gain", "always tired", "feeling cold" can all be signs of thyroid disease, but they're also signs of many other things — they belong on `fatigue` and `weight-related-concerns-in-adults`, not on `hypothyroidism`. Specific-diagnosis pathways should keep clinical-specific terminology only.

---

## Source of truth: `.md` frontmatter

`docs/blog/index.json` is a **derived artifact**. The canonical data is in the YAML frontmatter of each `.md` file.

### Standard frontmatter schema

```yaml
---
title: "Pathway: Hypertension in Adults"
type: "pathway"          # article | reference | guideline | pathway
tags: ["Guideline"]
keywords: ["hypertension", "high blood pressure", "hbp", "htn", ...]
summary: "Clinical pathway for hypertension in adults..."
---
```

### Rebuilding the index

```bash
cd ~/Documents/roadmap
npx tsx scripts/rebuild-blog-index.ts
```

This scans all `.md` files in `docs/blog/`, `docs/guideline/`, `docs/pathway/`, extracts frontmatter, and writes `docs/blog/index.json`. Run after editing any `.md` file or batch keyword additions.

### Why .md-first

- Each pathway .md has both content and metadata in one place (easier for agents to edit atomically)
- Rebuilding the index from .md guarantees consistency
- Git diffs are human-readable per pathway
- New content added by batch agents (e.g., a new HealthPathways scrape) picks up automatically on rebuild

**Common mistake**: editing `index.json` directly. Those changes will be wiped on the next rebuild. Always edit `.md` files and rebuild.

---

## Synonym expansion

File: `~/Documents/roadmap/app/lib/synonyms.ts`

33 equivalence sets (as of v232). Each set is an array of terms that all refer to the same concept — at query time, if ANY term in a set appears in the user's message, all OTHER terms in the set are added to the search.

```typescript
export const SYNONYM_SETS: string[][] = [
  ["hypertension", "high blood pressure", "hbp", "htn", "elevated blood pressure"],
  ["myocardial infarction", "heart attack", "mi", "cardiac event"],
  ["type 2 diabetes", "t2dm", "t2d", "type ii diabetes", "diabetes mellitus"],
  ["sleep apnoea", "sleep apnea", "osa", "obstructive sleep apnoea", "obstructive sleep apnea"],
  // ...
];
```

### Covers

- Clinical abbreviations ↔ full terms (HTN, T2DM, OSA, BPH, LUTS, GORD, IBS, PID, PCOS, COPD)
- UK/US spelling variants (apnoea/apnea, haemoglobin/hemoglobin, oestrogen/estrogen)
- Lay ↔ clinical mappings (high blood pressure ↔ hypertension, acid reflux ↔ gastro-oesophageal reflux)
- Lab test abbreviations (HbA1c, LDL, TSH)
- Common supplement variants (omega-3 / omega 3 / fish oil / EPA DHA, vitamin B12 / B12 / cobalamin)

### Rule for adding a set

Every term must be **safely interchangeable** in a search context. Examples of what NOT to add:
- "tumor" and "cancer" — many tumors are benign
- "fever" and "infection" — fever has many causes
- "pain" alone — too broad

If a symptom points to many conditions, it's not a synonym — it's a symptom pathway routing question (see keyword placement rule above).

### Word-boundary matching for short terms

Terms ≤4 chars use `\b` regex matching. Without this, "ed" matches the "ed" suffix in "gained", "mi" matches "minimum", "ain" matches inside "migraine". With word boundaries, only standalone occurrences trigger expansion.

### Bidirectional by design

The expansion works in both directions. A user typing `"htn"` gets expanded to include "hypertension", "high blood pressure", etc. A user typing `"hypertension"` gets expanded to include "htn", "high blood pressure", etc. This covers the case where a blog article might be indexed under a lay term while a pathway is indexed under the clinical term.

---

## Matcher scoring

Function: `matchBlogArticles(userMessage: string, maxResults = 3)` in `~/Documents/roadmap/app/lib/chat.server.ts`

For each of 991 entries, compute a score:

```typescript
score = 0
msgLower = expandQuery(userMessage).toLowerCase()

for (kw of entry.keywords):
  kwLower = kw.toLowerCase()
  if kwLower.length <= 4:
    if \b{kwLower}\b in msgLower:  // word-boundary match
      score += 2
  else:
    if msgLower.includes(kwLower):  // substring match
      score += 2

for (tag of entry.tags):
  if msgLower.includes(tag.toLowerCase()):
    score += 1

titleWords = entry.title.lower().split(/\W+/).filter(w => w.length > 3)
for (word of titleWords):
  if msgLower.includes(word):
    score += 1

if (entry.type == 'pathway' || entry.type == 'guideline') and score > 0:
  score += 8
else if entry.type == 'reference' and score > 0:
  score += 5

if score > 2:
  matches.append({handle, score})

return top 3 by score descending
```

### Why keyword+tag+title scoring

- **Keywords (+2)**: highest signal — these are curated terms a patient or clinician would type
- **Tags (+1)**: broad categories ("Supplements", "Research") — less specific, lower weight
- **Title words (+1)**: fallback for naturally-occurring vocabulary overlap
- **Type boost (+8 or +5)**: prioritize clinical content (pathways/guidelines > reference articles > blog posts)

### Why substring match (not token/semantic match)

- Zero per-query cost — no embedding, no LLM call
- Deterministic, fast (<1ms against 991 entries)
- Works with the Sonnet model already in use — LLM handles semantic nuance after content is loaded
- Synonym expansion handles the main substring limitations (different vocabulary for the same concept)

Revisit if the knowledge base grows past ~5,000 entries or if real user feedback (Phase 3) shows persistent relevance failures.

### Known scoring limitations

The flat +8 pathway/guideline boost produces ties at score 10 (single keyword match + boost). When multiple candidates share a single generic keyword, tie-breaking becomes arbitrary. Phase 2 work addresses this (multiplicative boost, raised threshold, stopword filtering on title words).

---

## Content loading

Function: `loadBlogArticle(handle: string)` in `chat.server.ts`

- Reads the .md file from the correct directory based on the entry's `type` field
- Strips the YAML frontmatter (keeps only the body content for the LLM)
- Caches in-memory after first read (`blogArticleCache` map) — no per-request disk I/O after first access
- Handle validation via `/^[a-z0-9-]+$/` prevents path traversal
- Articles are capped at ~20K tokens as a safety guard

For a single user query, up to 3 matched articles are loaded. If combined content exceeds ~80K chars (~20K tokens), lower-scored matches are dropped.

**Cost per message**: ~$0.004 extra when content matching triggers. Most messages (health data questions, order lookups, product Q&A) don't trigger a match because their answers come from the cached system prompt.

---

## Prompt cache layout

Anthropic's prompt caching marks content blocks with `cache_control`. Identical content across requests is served at 90% lower cost with lower latency.

```
┌──────────────────────────────────────────────────────┐
│  SYSTEM PROMPT + ALGORITHM                           │
│  Role, scope, output rules, disclaimer               │
│  + health_roadmap_algorithm.md                        │
│  ~13K tokens                                         │
│  cache_control: { type: "ephemeral" }  ← breakpoint 1│
├──────────────────────────────────────────────────────┤
│  EVIDENCE                                            │
│  Full evidence.ts serialized (DOIs, guideline tags)  │
│  ~5K tokens                                          │
│  cache_control: { type: "ephemeral" }  ← breakpoint 2│
├──────────────────────────────────────────────────────┤
│  PRODUCTS                                            │
│  docs/products.md — MicroVitamin, MV+, Sleep,        │
│  omega-3 recommendation                              │
│  ~8K tokens                                          │
│  cache_control: { type: "ephemeral" }  ← breakpoint 3│
├──────────────────────────────────────────────────────┤
│  KNOWLEDGE BASE OVERVIEW                             │
│  Article counts, guideline summaries, pathway        │
│  categories with examples. Constant size regardless  │
│  of entry count.                                     │
│  ~2-3K tokens                                        │
│  cache_control: { type: "ephemeral" }  ← breakpoint 4│
├──────────────────────────────────────────────────────┤
│  USER CONTEXT (not cached — per-user)                │
│  Profile, measurements, medications, screenings,     │
│  current suggestions, document titles                │
│  ~2K tokens                                          │
├──────────────────────────────────────────────────────┤
│  ORDERS (not cached in prompt — 10-min server cache) │
│  Recent orders + tracking links from Shopify         │
│  ~0.5K tokens                                        │
├──────────────────────────────────────────────────────┤
│  MATCHED CONTENT (not cached — on-demand)            │
│  Up to 3 articles/pathways from the matcher          │
│  ~2-8K tokens                                        │
├──────────────────────────────────────────────────────┤
│  MESSAGES (not cached — per-request)                 │
│  Conversation history + new user message             │
│  ~2-8K tokens                                        │
└──────────────────────────────────────────────────────┘
```

### Why this layout

- **Breakpoints 1-3** are identical across all users and requests. One cache write serves every user for 5 minutes.
- **Breakpoint 4** (knowledge overview) is ~2-3K tokens regardless of knowledge base size. Individual titles/keywords/summaries stay in server memory (`BLOG_INDEX`), not in the prompt. The matcher uses them on every request to find relevant content.
- **User context and below is NOT cached** — different per user. Placing it after the cached blocks is correct — uncached tokens after a cache hit are fine.

### Cost per message (with prompt caching)

| Component | Tokens | Rate | Cost |
|---|---|---|---|
| Cached static portion (hit) | ~28K | $0.10/MTok | $0.0028 |
| Uncached dynamic portion | ~7K | $1/MTok | $0.007 |
| Output | ~500 | $5/MTok | $0.0025 |
| **Total per message** | | | **~$0.012** |

Cache misses (first request in a 5-min window): ~28K × $1.25/MTok = $0.035 for the static portion. Amortized across users, most requests are cache hits.

### Cache invalidation

Cache is invalidated when any of:
- `health_roadmap_algorithm.md` content changes
- `evidence.ts` content changes
- System prompt text (`chat-system-prompt.md`) changes
- `products.md` content changes
- Knowledge base overview composition changes (e.g., new guideline added)

All infrequent (weekly at most).

---

## Knowledge base overview (in the cached prompt)

Function: `buildKnowledgeOverview()` in `chat.server.ts`

At server startup, this runs once and bakes a ~2-3K token description of the knowledge base into the cached system prompt. Tells the LLM:

- How many blog/reference/guideline/pathway entries exist
- What topics the blog articles cover
- Full summaries of the 3 guidelines (diet, exercise, sleep)
- Pathway categories with example conditions

The LLM uses this to know what's available, but doesn't see individual titles or keywords. It can say "I have clinical pathways on that topic" without seeing the list; when the matcher surfaces one, it gets injected as matched content.

---

## Test harness

File: `~/Documents/roadmap/tools/test-chatbot-matching.js`
Data: `~/Documents/roadmap/tools/test-queries.json`

196 realistic patient queries with expected-pathway handles. Runs a replica of `matchBlogArticles()` (kept in sync with the production function) and reports pass/fail per category.

```bash
node tools/test-chatbot-matching.js                   # baseline
node tools/test-chatbot-matching.js --with-synonyms   # with query expansion
node tools/test-chatbot-matching.js --verbose         # show passing queries too
node tools/test-chatbot-matching.js --category sleep  # filter
```

Current state (v232):
- **77.6% pass rate** (152/196)
- All 15 established categories at 100% (cardiovascular, metabolic, mental-health, sleep, musculoskeletal, GI, respiratory, women's/men's health, dermatology, neuro, bone-health, lifestyle, ambiguous edge cases, supplement)
- New patient-voice categories: symptomatic 72%, pediatric 67%, palliative 78%, pregnancy 58%

The test harness is the regression gate for any future matching change — run it before and after any change to the matcher, synonym map, or index.

---

## System prompt

File: `~/Documents/roadmap/app/lib/chat-system-prompt.md`

Pure markdown file, read at module load via `fs.readFileSync`. Kept out of `chat.server.ts` so Brad can edit the prompt as prose without TypeScript syntax noise.

Defines the chatbot's role, scope boundaries, and safety rules. Full algorithm doc (`health_roadmap_algorithm.md`) is concatenated after the prompt at module load — both live in cache breakpoint 1.

See [`chat-feature.md`](./chat-feature.md) for the behavior specification the prompt enforces.

---

## Known limitations & future work

### Phase 2: Scoring algorithm tuning

Remaining test harness failures (44/196) are mostly scoring issues:
- Flat +8 boost means generic pathways beat specific reference articles
- Score ties at 10 break arbitrarily
- Title word matching includes too-short or too-generic words ("symptoms", "treatment")

Planned fixes:
- Multiplicative boost (`score *= 1.5` for pathways) instead of additive
- Raise threshold from `> 2` to `> 4`
- Stopword list for title word matching
- Basic plural handling ("vitamins" → "vitamin")
- Extend query fallback to always include first user message

### Phase 3: Feedback loop infrastructure

- Add `matched_handles TEXT[]` column to `chat_messages` (log what the matcher surfaced)
- `CHAT_NO_MATCH` audit log event for queries that failed to match
- `chat_feedback` table — thumbs up/down per assistant message
- UI for feedback

### Phase 4: Periodic LLM linting

After 2-4 weeks of feedback data:
- Pull thumbs-down messages + their matched handles → prioritized fix list
- Analyze no-match queries → content gaps
- Cross-reference related pathways via LLM
- Conflicting-advice detection across pathways

### Why not vector search

Substring matching runs at zero marginal cost, works in-memory, is deterministic, and handles 991 entries well. Vector search would add pgvector, embedding costs, per-query latency, and debugging complexity. The synonym map + Phase 2 scoring fixes close the remaining gap for far less complexity. Revisit if the knowledge base grows past ~5,000 entries or feedback shows persistent relevance failures the matcher can't address.

---

## Critical files

### Production code
- `app/lib/chat.server.ts` — `matchBlogArticles()`, `expandQuery()`, `loadBlogArticle()`, `buildKnowledgeOverview()`, `buildSystemBlocks()`
- `app/lib/synonyms.ts` — 33 synonym equivalence sets
- `app/lib/chat-system-prompt.md` — system prompt (pure markdown)
- `app/routes/api.chat.ts` — chat API endpoint, conversation CRUD, order fetching

### Content
- `docs/blog/*.md` — 165 blog articles + 113 reference articles
- `docs/guideline/*.md` — 3 guidelines (diet, exercise, sleep)
- `docs/pathway/*.md` — 710 clinical pathways (HealthPathways)
- `docs/blog/index.json` — derived index, rebuild via script
- `docs/pathway/categories.json` — specialty → condition map for knowledge overview
- `docs/products.md` — symlink to `claude_business/docs/products.md`

### Tooling
- `scripts/rebuild-blog-index.ts` — regenerate index.json from .md frontmatter
- `scripts/build-blog-content.ts` — fetch blog articles from Shopify Admin API
- `tools/test-chatbot-matching.js` + `tools/test-queries.json` — regression harness
- `tools/scrape-healthpathways.js` — Playwright batch scraper for HealthPathways

### Storage
- Supabase `chat_conversations`, `chat_messages`, `guest_chat_sessions`, `chat_feedback` (planned), `audit_logs`