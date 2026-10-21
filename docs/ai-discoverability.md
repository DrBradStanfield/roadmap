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
  description. Six guides carry `TechArticle` JSON-LD.
- `/pages/start` and `/pages/health` are hidden (page metafield `seo.hidden`=1):
  noindex and out of the sitemap. `/pages/health-plan` is still indexable.
- GitHub repo: description, homepage, 11 topics, `glama.json`, release v1.0.2.
- `get-plan --from-values`: a plan from numbers with no record file (US-30 AC7).

### The supplements (microvitamin.com)

- Product JSON-LD with per-market doses, maker, GTIN and `sameAs`.
- `llms.txt` with live review counts and a cross-link to potassiumfiber.com.
- Alt text on 77 images. Shopify's agent shopping (`/.well-known/ucp`,
  `llms-full.txt`, WebMCP) is on by default. Google Merchant Center connected.

### Listings for the hosted MCP

| Where | State | Link or ID |
| --- | --- | --- |
| Official MCP Registry | Listed | namespace `io.github.DrBradStanfield` |
| OpenAI (ChatGPT apps) | 1.0.2 in review since 2026-10-14 | [chatgpt-app-listing.md](chatgpt-app-listing.md) |
| Claude directory | Submitted 2026-10-21, in review | [claude-directory-listing.md](claude-directory-listing.md) |
| Glama | Server and connector listed, claimed, build passes; tools rated A, maintenance B | glama.ai/mcp/servers/DrBradStanfield/roadmap |
| mcp.so | Live, paid ($39) | mcp.so/servers/health-by-dr-brad |
| awesome-mcp-servers | PR open, Glama badge added | punkpeye/awesome-mcp-servers#17137 |
| Wikidata | Item created | Q141797039 (developer Q141452826) |
| Smithery | Closed to new servers (403, shutting down) | none |
| PulseMCP | Submissions paused | retry later |

## Waiting

- **OpenAI 1.0.2 verdict.** Then merge PR #209 (`annotations.title`, and
  tools/list stops leaking internal fields), held by the US-35 AC13 freeze.
- **First directory verdict.** Then set `MCP_REVIEWER_VENDORS` on
  health-tool-edu back to the vendor still reviewing.
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

1. **Bing Webmaster Tools** on all three sites (none carries a Bing
   verification tag, 2026-10-21). ChatGPT and Copilot search lean on Bing.
   Free: Bing imports sites from Google Search Console in one step.
2. **YouTube descriptions:** the `/pages/roadmap` link and one line on the
   connector. Gemini and Perplexity cite YouTube heavily.
3. **potassiumfiber.com in Google Search Console** (no Google verification
   tag on the site, 2026-10-21; about 25,000 potassium impressions sit on
   drstanfield.com articles now).
4. **Task guides** for the questions people ask inside the tool: uploading a
   lab PDF, fixing a wrong value, finding the record file.
5. **Glama tool descriptions:** the score page asks for read_record and
   get_plan to name their siblings, and for import_documents and file_results
   to be less dense. This changes tools/list, so it waits for the OpenAI verdict.
6. **Third-party testing for MicroVitamin,** under way. A citable certificate
   answers the ConsumerLab "Not Approved" page that models quote.
