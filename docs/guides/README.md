# Guides

Public how-to guides, published at drstanfield.com/blogs/guides. One `.md` file per guide.

## The contract

- **The `.md` file is the master.** The blog HTML is generated from it. Never hand-edit the published HTML.
- **Style: [writing-style.md](../writing-style.md), plus Zinsser per CLAUDE.md.** Short sentences. Plain words. Sentence-case headings. No em dashes. No hype adjectives.
- **Verify every fact against the repo before it ships**: paths, URLs, commands, rules. Read the code; do not recall it. Never describe a capability we do not have.
- **Every built page ends with a link to its `.md` master** on raw.githubusercontent.com, so an agent can fetch the source instead of scraping the page. The build appends it; do not write it by hand.
- **No health data, no invented users, no testimonials.**

## Front matter

```yaml
---
title: "..."                 # SEO title, aim <= 60 characters
description: "..."           # meta description, one sentence, aim <= 155 characters
slug: "..."                  # URL segment under /blogs/guides/
updated: "2026-09-01"        # ISO date, bumped on every content change
stories: ["US-29", "US-30"]  # the user stories this guide serves
---
```

`scripts/build-guide-html.mjs` only needs `title:` and `slug:` to run; it refuses a guide missing either. `description`, `updated` and `stories` are for the site and for us, not the build, but write them anyway: they are part of the contract above.

## Markers

A marker on a line of its own is replaced by the build. Markers keep the `.md` readable and keep generated markup out of the master.

```
[connect:chatgpt]        a connector button for that AI provider
[connect:claude]
[diagram:local-first]    a named inline SVG from the build's diagram set
```

`connect:` button states live in `assets/providers.json`: `soon` renders a disabled greyed span, `live` renders a link to that provider's `url`. **A button must never promise what does not work today**: disabled and honest beats live and broken. A provider we have no plan for gets no button at all, not a greyed one.

**A button never adds a connector on the reader's behalf, because no vendor lets it.** Anthropic publishes a link that PREFILLS the Add custom connector dialog for the user to confirm; OpenAI publishes nothing equivalent. So a live `url` is `#`-anchored at a step list further down the same page, and the build's shipped-guides test fails if the heading that anchor names is gone. A vendor link belongs inside those steps, in prose that says what it does.

**Copy boxes.** A block the reader is meant to take whole goes in a fence tagged `bootstrap-prompt` (a setup prompt) or `copy-box` (an address, a config block). Each renders a box with its own Copy button, which copies its own `<pre>`, so a guide can hold several and none can serve another's text. Under `--no-script` every box degrades to a plain block with a select-all hint.

## Stories

`stories` maps the guide to the user stories it serves. That mapping is for us. **Never publish test status, AC numbers, or story prose.** A guide says what works today and nothing about how we track it.
