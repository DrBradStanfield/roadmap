---
title: AI Discoverability
---

# AI discoverability

The living record of what we do so that AI assistants (ChatGPT, Claude, Gemini,
Perplexity, Copilot) find, cite and recommend **Health by Dr Brad** (the tool)
and **MicroVitamin** (the supplements). Update it in the same session as any
change below. The original plan and its reasoning:
[agent-discovery-plan-2026-10-20.md](agent-discovery-plan-2026-10-20.md).

## Rules (Brad's, never re-litigate)

- **drstanfield.com stays brand-neutral.** No supplement content, link or shop
  surface there (TGA ruling, plan § Brad's answers 2). The one exception: the
  `llms.txt` routing line to microvitamin.com.
- **Never link Dr Brad's personal socials on microvitamin.com.** Brand accounts
  only: Instagram @microvitamin_real, Facebook page 61591058535687.
- **One name:** "Health by Dr Brad" wherever an agent reads. Cloud folders keep
  "Health Plan by Dr Brad".
- **Agents get `/pages/roadmap`,** never `/pages/start` or the homepage.
- **potassiumfiber.com is the drink's main page.** No cross-domain canonical:
  each page stays self-canonical (Brad 2026-10-21).
- **No paid listicles, no seeded Reddit posts, no programmatic health pages**
  (plan § What I would not do).

## Live

### The tool (drstanfield.com, mcp.drstanfield.com)

- `llms.txt`, `llms-full.txt`, `agents.md`: point to `/pages/roadmap`, the MCP
  URL, the guides, the CLI, agent-access.md and the schema. Source:
  claude_business `tools/shopify-llms-txt.js`.
- `/pages/roadmap`: intro text, `WebApplication` JSON-LD, SEO title and
  description. Ten guides carry `TechArticle` JSON-LD, including upload-lab-report (upload
  and fix a value), find-your-record (where the file sits, backups, erase),
  track-blood-tests-with-ai (the entry page for "track my blood tests with
  ChatGPT or Claude"), connect-google-drive (the Drive box people miss) and
  where-your-data-lives (the privacy page: what touches our server, Supabase,
  Anthropic and others). Added 2026-10-22.
- `/pages/start` and `/pages/health` are hidden (page metafield `seo.hidden`=1):
  noindex and out of the sitemap. `/pages/health-plan` is still indexable.
- Google Search Console: all three sites verified by DNS record (potassiumfiber.com
  too, checked 2026-10-21).
- Bing Webmaster Tools: all three sites added. Sitemaps submitted for
  drstanfield.com and potassiumfiber.com on 2026-10-22; microvitamin.com's were
  already crawled.
- potassiumfiber.com has 10 articles of its own, including potassium citrate vs
  chloride and the other forms.
- GitHub repo: description, homepage, 11 topics, `glama.json`, release v1.0.2.
- `get-plan --from-values`: a plan from numbers with no record file (US-30 AC7).
- No third-party clinical pathways (2026-10-22, US-15 AC39): pathway content left the repo and the
  chatbot after the publisher wrote to Brad. No agent surface may describe the tool as built on
  third-party pathways. The live `llms.txt` credit was dropped and redeployed (claude_business 8fc2d9ed).

### The supplements (microvitamin.com)

- Product JSON-LD with per-market doses, maker, GTIN and `sameAs`.
- `llms.txt` with live review counts and a cross-link to potassiumfiber.com.
- Alt text on 77 images. Shopify's agent shopping (`/.well-known/ucp`,
  `llms-full.txt`, WebMCP) is on by default. Google Merchant Center connected.

### Listings for the hosted MCP

| Where | State | Link or ID |
| --- | --- | --- |
| Official MCP Registry | Listed | namespace `io.github.DrBradStanfield` |
| OpenAI (ChatGPT apps) | Declined 2026-10-29 on scope (health apps out of scope); left to stand. Custom connector in developer mode still works | [chatgpt-app-listing.md](chatgpt-app-listing.md) |
| Claude directory | Submitted 2026-10-21, in review | [claude-directory-listing.md](claude-directory-listing.md) |
| Glama | Server and connector listed, claimed, build passes; profile 83% (2026-10-21), tools A, maintenance B | glama.ai/mcp/servers/DrBradStanfield/roadmap (Admin → score) |
| mcp.so | Live, paid ($39) | mcp.so/servers/health-by-dr-brad |
| mcprush | Listed by them from a public index 2026-10-22, unclaimed; points straight at mcp.drstanfield.com (not proxied); category wrong (Lifestyle & Local) | mcprush.com/drbradstanfield/health-by-dr-brad-mcp |
| awesome-mcp-servers | PR open, Glama badge added | punkpeye/awesome-mcp-servers#17137 |
| Wikidata | Item created | Q141797039 (developer Q141452826) |
| Smithery | Closed to new servers (403, shutting down) | none |
| PulseMCP | Submissions paused | retry later |

## Waiting

- **Anthropic directory verdict.** Then unset the three reviewer secrets
  and delete the reviewer sign-in code in a reviewed commit (Brad
  2026-10-29). OpenAI's half went off 2026-10-29 (`MCP_REVIEWER_VENDORS=anthropic`).
- **Brad:** add the brand socials in microvitamin.com's theme editor; set
  per-market descriptions in Translate & Adapt (UK, EU and Canadian answers
  still say "26 ingredients").
- **potassiumfiber.com in Google Merchant Center** once the drink is for sale.

## How we check

- **Hand check, about 10 prompts, in a private window,** every three months.
  Log: are we named, which competitors are, which URLs are cited. Last run
  2026-10-21: both products and the tool appear only when asked by name.
  Generic prompts name Centrum and Thorne (supplements) and Function Health and
  HealthEx (tool).
- **AI crawlers** (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) are not
  blocked in any of the three sites' `robots.txt`. Keep it that way.
- **AI referrers** in the weekly product-health loop (Clarity and Shopify).

## Ideas not yet done

Ranked by cost against likely effect.

1. **YouTube descriptions:** the `/pages/roadmap` link and one line on the
   connector. Gemini and Perplexity cite YouTube heavily.
2. **Glama tool descriptions:** read_record and get_plan name their siblings,
   import_documents and file_results made easier to scan. Ships with PR #209,
   unheld 2026-10-29 after the OpenAI verdict.
3. **Glama to 100%.** "CI is failing" and "No stable releases" were stale on
   2026-10-21 and should clear on the next scan. "No recent usage": a sandbox
   get_plan call ran through "Try in Browser" on 2026-10-21. "No related
   servers": the admin's own pick of similar servers. Glama already shows
   similar ones on our page automatically; picking them is optional.
4. **Third-party testing for MicroVitamin,** under way. A citable certificate
   answers the ConsumerLab "Not Approved" page that models quote.
