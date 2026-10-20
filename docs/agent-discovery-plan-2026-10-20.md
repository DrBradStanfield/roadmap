---
title: Agent Discovery Plan
artifact: https://claude.ai/artifact/MyULJyAnyktw2JqbeYjSuk
---

# Getting AI agents to use and recommend our products

Plan, 2026-10-20, from the Railway threads Brad saved on X. Status: **revised after one fresh Opus 5.5 adversary review; Brad answered the first decisions the same day (end of page). His answers override the phases below where they differ.** Nothing here is built.

## What the X posts claim

Three posts (Ilias Ism, Ira Bodnar, quoting Nakul Mandan's interview with Railway's founder). Their claims, unverified:

- Railway grew from $20M to about $100M ARR in 2026 with a 7-person go-to-market team.
- The founder treats "getting the models to recommend us" as a growth channel.
- The levers: an MCP server, a CLI and `ssh railway new`, so an agent can start a server with no account; 127 framework deploy guides; 6,653 "how to self-host tool X" pages; a comparison page against each competitor; an index of 414 doc pages with a plain-text version of each; a docs section for agents; plugins inside ChatGPT and Claude Code; a weekly changelog since 2021.
- One post says Claude Code picks Railway for 82% of Python apps. It gives no source.
- The first post ends by selling two paid services: an AI-ranking tracker, and placement in "ranking listicles" on high-authority sites.

## Why our case is different

Railway sells to an agent that is in the middle of a task. A coding agent is told "deploy this", must pick a host, and acts. The agent is the buyer.

Our cases split in two:

- **The health tool.** An assistant asked about LDL answers the question itself. It reaches for a tool only when the user wants something kept: "track my blood tests over time", "connect my health records to Claude". That market is narrower than Railway's. It is real, and few tools serve it. Our product suits agents well: an open file format, a public schema and a hosted MCP.
- **The supplements.** Here the assistant does recommend. It recommends from what it can cite: Examine, ConsumerLab, Labdoor, Reddit and "best multivitamin" lists. Health is a high-scrutiny topic for models and regulators. Each market has its own formula and claim rules (products.md "Regional Formula Differences"). The potassium drink may make no health claim at all.

## Where we stand

| Railway lever | Us now | Gap |
| --- | --- | --- |
| Agent shopping | **Already live on all three domains.** Shopify serves `/.well-known/ucp` (200) and an auto-generated `/llms-full.txt` ("Agent Instructions … browse products and shop at …"), with WebMCP tools on the storefront | drstanfield.com's Shopify file says "shop at drstanfield.com". Our own `llms.txt` there says the site "does not host product information". The two contradict each other |
| `llms.txt` index | Live on all three sites | drstanfield.com's lists the tool as `https://drstanfield.com/`, not `/pages/roadmap`, and never mentions the MCP, the guides or the schema |
| Plain-text versions | Each guide ends with a link to its raw `.md` on GitHub | Blog articles have none |
| Docs for agents | [agent-access.md](agent-access.md), the public JSON schema, 5 guides at `/blogs/guides` | No single "agent, start here" file |
| ChatGPT plugin | 1.0.2 in OpenAI review | Waiting on OpenAI |
| Claude directory | The custom connector works on every plan | A listing needs a Team org ([assistant-landscape.md](assistant-landscape.md)) |
| MCP registry | Not listed | The official MCP Registry (preview) takes remote servers |
| No-signup path | The web tool works as a guest | An agent cannot give a user a plan without a Dropbox, Drive or GitHub connection. The CLI cannot create a record ([command-line.md](guides/command-line.md)) |
| Task guides | 5 | Railway has 127 |
| One product name | Three: "Health by Dr Brad", "Health Plan by Dr Brad" (cloud folders), "Health Roadmap" (`llms.txt`) | Models match one name more reliably than three |
| Comparisons | Competitor prices and forms in microvitamin.com's `llms.txt` (AG1 $79/mo, Thorne, Centrum) | Undated, unsourced, and they go stale |
| Third-party testing | Labdoor certifies Sleep | ConsumerLab marked MicroVitamin "Not Approved" in early 2026 (products.md, FAQ). Models may already cite that page |
| Measurement | None | We do not know what any assistant says about us |

**Traffic.** Clarity, 18–20 Oct: no AI assistant is in the top 10 referrers on microvitamin.com; on drstanfield.com only gemini.google.com is, with 7 sessions against Google's 1,497. Three days and a top-10 cut hide small sources. ChatGPT clicks often arrive with `utm_source=chatgpt.com` or no referrer at all. A real baseline needs 28–90 days of Shopify referrer data.

## The plan

Cheapest first. Each phase must earn the next.

### Phase 0: measure

1. **Baseline:** 90 days of Shopify referrer data, filtered by AI hosts and by `utm_source=chatgpt.com`. Free.
2. **A fixed prompt set**, about 30 prompts in three groups, scored separately:
   - *Neutral, in the user's voice:* "how should I keep track of my cholesterol results", "best multivitamin for a 50-year-old".
   - *Niche:* "health tracker I can connect to Claude", "MCP server for health records", "multivitamin without vitamin A", "AG1 alternative", "low-dose sustained-release melatonin".
   - *Reputation:* "is MicroVitamin any good", "MicroVitamin ConsumerLab".
3. **Log three things:** are we named, which competitors are, and which URLs are cited.
4. **Sampling:** at least 5 runs per prompt per assistant, reported as a rate with its spread. One run per prompt is noise.
5. **Which surface:** say which we measure. APIs behave differently from the consumer apps. Manual runs must use logged-out or fresh accounts: Brad's own accounts remember his products.
6. **Paperwork:** a loop needs a registry row and a success signal before its first run.

The cited URLs are the real output. They show which pages the models trust, so later work aims at real targets.

### Phase 1: fix what exists (one session)

1. **Decide drstanfield.com's shop surface.** Should the education site offer agent shopping? Then make its two agent files agree. This is Brad's call; see decisions.
2. **drstanfield.com `llms.txt`:** link `/pages/roadmap`; add a "For AI agents" section with the MCP URL, the guides, the schema and agent-access.md.
3. **Pick one product name** and use it everywhere an agent reads.
4. **An agent entry file,** `docs/guides/for-agents.md`, published as a guide: what the tool does, the ways in, and steps an agent can follow alone. This is our `SKILL.md`.
5. **List the hosted MCP in the official MCP Registry.** It needs a `server.json` and proof that we own the domain: a DNS TXT record (a Brad step on Shopify) or an HTTP file.
6. **App schema** (`WebApplication`) on `/pages/roadmap`.
7. **YouTube:** put the `/pages/roadmap` link and one line on the AI connector in video descriptions. Gemini and Perplexity cite YouTube heavily, and the channel has 319,000 subscribers.
8. **Bing Webmaster Tools and IndexNow** on all three sites. ChatGPT search leans on Bing. Free.
9. **Re-check microvitamin.com's competitor bullets.** Each fact gets a source and a date, or comes out.

`llms.txt` is cheap hygiene. No major assistant has confirmed it reads the file, so it is not a growth lever.

### Phase 2: a no-signup path for agents (a feature, gated)

Railway's best idea is a short path from "an agent heard of you" to "the user sees a result". Three options, ranked by what leaks:

1. **CLI from JSON on stdin** (best first step). `get-plan` takes values on stdin and prints the plan. No account, nothing leaves the machine. Serves Claude Code and other coding agents. Small change.
2. **WebMCP tools on `/pages/roadmap`.** A browser agent fills the form inside the page. Nothing enters a URL. Shopify already runs WebMCP on these storefronts.
3. **A prefilled link** (`/pages/roadmap#…`). Reaches the most users, because any chat assistant can write a link. It also leaks the most:
   - Clarity and Shopify's analytics load before our widget can clear the fragment. Shopify's page-view event carries the full URL.
   - The values sit in browser history (synced across devices) and in any copy of the link the user shares.
   - A stranger can craft a link with wrong values under Dr Brad's name.
   - Build it only if a recorded test proves the fragment never leaves the page.

**Rules for all three:**

- Values from an agent are **preview only.** Nothing is saved until the user confirms. A connected user sees a banner, and nothing merges into the stored record. Today the form auto-saves sex, birth year and height on a short delay (`HealthTool.tsx`). Those fields win on every device after a merge.
- Every value carries its unit and passes the existing validation.
- Lane B: a story with these as acceptance criteria, and a usage event that holds no URL and no value. Review by a fresh adversary plus Codex.
- **Gate:** build it only after Phase 0 shows assistants name us. A path that no agent knows about will get no use.

Rejected: an unauthenticated "preview plan" tool on the hosted MCP. It would put a public endpoint on Brad's server, which CLAUDE.md forbids.

### Phase 3: content, aimed by Phase 0's data

- **Tool: 10–20 task guides,** not thousands. Each answers one question a user asks an assistant, like "track ApoB over time with ChatGPT". Opus writes them, under the guide contract.
- **Supplements: answer pages** for the questions where Phase 0 shows we are missing. Built from products.md wording. Each names its market and follows that market's claim rules. "Third-party tested" is a US-only claim.
- **ConsumerLab.** If Phase 0 shows models cite the "Not Approved" page, make our answer citable: the published certificate, the batch sheet, and the overage change in the new formula.
- **Comparison pages,** only with a dated source for every competitor fact and a named owner to refresh them.

## What I would not do

- **Buy listicle placement.** A paid ranking dressed as editorial is an undisclosed endorsement under FTC rules and link spam under Google's. It also breaks Brad's open-about-conflicts stance.
- **Thousands of programmatic pages.** Railway's pages explain software. Ours would explain lab values. That breaks the three-file clinical sync, hits Google's scaled-content policy, and risks wrong medical text at scale.
- **Seed Reddit or forums.** Same problem as paid lists.
- **Promote the potassium drink here before it ships** on 1 December. It may make no claims, and its pages and `llms.txt` already exist. Look at Phase 0 data in December.

## Cost

| Phase | Money | Agent time | Brad's time |
| --- | --- | --- | --- |
| 0 | API runs: about $20–60 a month at 5 samples. Needs new OpenAI, Gemini and Perplexity keys; only a capped Anthropic key exists. Or $0 by hand | One session to build | Hand runs: several hours a month. Otherwise one yes on spend |
| 1 | $0 | One session | DNS record; name choice; shop-surface call |
| 2 | $0 | 1–2 sessions, plus adversary, Codex and WebKit checks | Story sign-off, deploy |
| 3 | Opus usage per page. Testing fees: unknown, ask the vendor | Ongoing | Sign-off on every page |

## Brad's answers (2026-10-20)

1. **Which URL agents get.** The tool runs on the homepage and on `/pages/roadmap`; each page is its own canonical. Agents get **`/pages/roadmap`**: the page exists only for the tool, it matches the rule for emails and replies (Brad 2026-10-14), and the homepage can change. `llms.txt` keeps the homepage as "about Dr Brad".
2. **drstanfield.com stays brand-neutral.** The reason is in claude_business (compliance ruling 2026-06-18, content map §15–16). Australia's TGA rules bar a doctor who is also the supplier from promoting his own therapeutic goods, even by naming them, and disclosure does not cure it. So:
   - No supplement content, link or agent shopping surface on drstanfield.com. The one kept exception is the existing `llms.txt` routing line to microvitamin.com (Brad 2026-06-25).
   - drstanfield.com has no products (`/products.json` is empty), so Shopify's agent file there sells nothing. It does call the site "Dr Brad Stanfield's online store". Turn the channel off there if Shopify allows it.
   - Every supplement idea in this plan lives on microvitamin.com only. The tool's agent files and guides name no product.
3. **Measurement, cut down.** Phase 1 is cheap enough to do without proof. A monthly multi-model study is dropped. Kept: AI referrers in the weekly product-health loop (free), and one hand check of about 10 prompts in a private window, now and again in three months, to see whether anything changed and which pages the models cite. Phase 2 and Phase 3 still wait on that check.
4. **Name: "Health by Dr Brad"** everywhere an agent reads. The cloud folders keep "Health Plan by Dr Brad": existing Dropbox folders cannot be renamed.
5. **The CLI exists.** `get-plan` prints a plan and `edit-record` files a value ([command-line.md](guides/command-line.md)). The gap is narrower: both need a `health-roadmap.json` the web app already made with a cloud connection, and both need this repo cloned. Phase 2 option 1 means letting `get-plan` take values with no record file. Small, and nothing leaves the machine.
6. **Third-party testing for MicroVitamin** is already in the works. Phase 3's ConsumerLab item waits on its result.

## What we measured and shipped (2026-10-20, later the same day)

### What ChatGPT says (logged out, one run per question, 11 questions)

- It named us once, when asked "Is MicroVitamin any good?". That answer raised the ConsumerLab result and the Labdoor pass.
- The tool came up in none of the 5 tool questions. Its places went to blood-test apps, Apple Health, Oura and WHOOP. For "MCP server for health records" it cited GitHub projects, not ours.
- MicroVitamin came up in none of the unbranded supplement questions. Answers leaned on NZ retailers.
- Perplexity blocked logged-out use after one question. Claude and Gemini were not tried.

### What the warm audience does (90 days)

- **The tool is almost invisible in search.** `/pages/roadmap` gets 7,670 impressions, all for the brand name.
- **AI referrals are small but land on intent pages.** About 190 sessions to drstanfield.com, 13 of them to the tool. About 215 to microvitamin.com, almost all product pages.
- **The connect funnels leak.** 92 people started a Google Drive connect: 48 succeeded and 18 were refused because they left Google's Drive box unticked. 29 of 86 Drive visitors reached no outcome at all. The hosted MCP connected 15 times. Its 9 refusals were protocol rejections, not users; review owed.
- **The connect-chatgpt guide's searches are not ours.** "chatgpt failed to connect to health" most likely comes from people using OpenAI's own ChatGPT Health. Don't read it as demand for our connector.
- **Questions people ask inside the tool:** lipid targets and statins (24 of 106 messages), supplement doses, and how-to: uploading a PDF, fixing a wrong value, finding the record file.
- **A potassium search cluster sits at positions 7-10:** about 25,000 impressions, mostly on drstanfield.com articles. potassiumfiber.com is not in Search Console.

Full reports: the session's scratchpad (warm-audience, connect-funnels, assistant-answers); not committed, as they hold chat paraphrases.

### Shipped

- **drstanfield.com agent files.** `llms.txt`, `llms-full.txt` and `agents.md` now point to `/pages/roadmap` as "Health by Dr Brad" and list the MCP, the guides, the CLI, agent-access.md and the schema. The Shopify-generated "shop at Dr Brad Stanfield's online store" text is gone. Source: claude_business `tools/shopify-llms-txt.js`.
- **The GitHub repo** has a description, the tool as its homepage, and 11 topics (mcp, mcp-server, personal-health-record, local-first, fhir, …).
- **PR #196, merged:** `get-plan --from-values` prints a plan from numbers with no record file (US-30 AC7).
- **PR #197:** a hint under Google Drive to tick the Drive box (US-09 AC21), and a `cloud_connect_cancelled` count (AC22). Needs a deploy and a real-WebKit check of the hint.

### Next, ranked by the warm data

1. Deploy #197, then watch the Drive refused share against W42 (about 4 in 10 starts).
2. Review the hosted MCP's protocol refusals: ChatGPT's `resource` and redirect-uri rejections.
3. A guide on uploading a lab PDF and fixing a wrong value.
4. Add potassiumfiber.com to Search Console. Then decide on a potassium-forms article there, nutrient content only.
5. List the hosted MCP in the official MCP Registry. Its `io.github.DrBradStanfield` namespace needs Brad's GitHub sign-in.
