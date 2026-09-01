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

## Markers

A marker on a line of its own is replaced by the build. Markers keep the `.md` readable and keep generated markup out of the master.

```
[connect:chatgpt]        a connector button for that AI provider
[connect:claude]
[diagram:local-first]    a named inline SVG from the build's diagram set
```

`connect:` buttons are links to our own connector flow, and each provider carries a state: live, or a disabled coming-soon button where we cannot support it yet. **A button must never promise what does not work today**: disabled and honest beats live and broken. A provider we have no plan for gets no button at all, not a greyed one.

A prompt a reader is meant to paste somewhere lives **once**, in a fenced block tagged `bootstrap-prompt`, and the build renders it into the copy box. It feeds the copy box only; it is never encoded into a button href. If that ever changes, the prompt block stays the single source both are generated from, so the button and the copy box cannot drift apart.

## Stories

`stories` maps the guide to the user stories it serves. That mapping is for us. **Never publish test status, AC numbers, or story prose.** A guide says what works today and nothing about how we track it.
