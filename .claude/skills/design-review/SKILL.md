---
name: design-review
description: A fresh-eye design review of a UI change from screenshots, ranked and fixed before Brad sees it. Use after any visible UI change, on the web widget or the iPhone app, before showing Brad or deploying, and when asked to "make it beautiful", "check the design" or "does this look right". Phone widths first. Adapted from Benji Taylor's Stageshow skill (MIT).
---

# Design review

Tests prove a screen works. This review asks whether it looks right: calm, clear,
the iPhone app's sibling. Brad wants the product beautiful on a phone first.

Adapted from the review and craft rules in Benji Taylor's Stageshow skill
(github.com/benjitaylor/skills, MIT, 2026). We kept what applies to a real product
and dropped the faux-UI parts (filler bars, cursors, framing a still).

## When

- After a UI change on the web widget or the iPhone app, before Brad sees it.
- Again on the live page after a deploy (theme CSS only reproduces live).
- Not for copy-only or clinical text changes.

## How

1. **Shoot.** Real screenshots, never a guess from code.
   - Web: the Shopify-like localhost (`npm run dev:shopify`, port 5174) or the
     live page, in real WebKit (`tools/webkit-verify.mjs`) at 375 and 390 wide,
     and desktop at 1440 and 1200. Every state: empty, onboarding, a full record
     with an urgent card, each section, settings, every sheet or form.
   - iPhone: simulator screenshots (light, dark, the largest Dynamic Type).
   - Use a throwaway demo record. Never Brad's phone, never real data.
2. **Review with fresh eyes.** Spawn a fresh `adversary`. Give it this file, the
   screenshot paths and a one-line brief. Not the builder's plan or reasons. It
   reads every image and returns the ranked list below. It edits nothing.
3. **Fix** the findings, worst first, then shoot again.
4. **Show Brad** the screenshots that matter, with what changed.

Round cap as for every review (docs/review-format.md): one full review and one
fix-scoped re-check. Then Brad.

## The reviewer's rules

- Judge the picture, from screenshots. Every finding names the screenshot.
- Look the way an exacting designer would: find the one thing you'd screenshot
  and send back with "what is this?". Then the next.
- Rank by how much of the screen it spoils, not how easy it is to fix: layout and
  hierarchy first, then density and spacing, then polish.
- Don't soften a finding because the build is nearly there. Say what you could
  not check.
- First question: does this look like one calm product, the iPhone app's
  sibling, or a generic dashboard? A layout nobody shaped is a finding.
- A full-page capture shows fixed bars mid-page. That is the capture, not a
  finding.

## Checklist

**Hierarchy and restraint**
- The eye lands first on what matters: the section title, the value, an urgent
  card. Not on chrome, borders or labels.
- One number is big per row; the rest are quiet.
- Say it once: no feature or finding signalled in three places.
- Hierarchy comes from space, size and one weight step, not more boxes and borders.
  A stack of identical bordered cards is flat.
- No empty bands, no voids under a list, no content stopping short of its panel.
- A control row (sign in, settings) never takes a row of its own on a phone
  when it can sit on the title line.

**Type**
- One family (the theme's or the system's). Sentence case.
- Phone text 13 to 17px; small text line height at least 1.3.
- A title over its subtitle reads as one item: 4 to 6px apart; the air comes from
  the row's padding.

**Spacing and alignment**
- Words keep at least 12px from a card edge (under 8px is a fault).
- Row padding about 12px; a one-line row three times taller than its words is fat.
- Text never touches a neighbour: a fixed 8 to 12px gap.
- Nested shapes pad evenly; outer radius = inner radius + padding.
- Columns line up across rows: fixed tracks; values right-aligned on one edge.
- No near-tangents: edges 1 to 3px apart look accidental. Align them or part them
  by 8px or more.
- Dots, badges and focus rings sit inside the content edge.
- A title sits closer to its own content than to the next section.
- A control hugs its content. A label beside an icon or in a pill is centred on
  its letters.

**Icons and colour**
- One icon set, one size, one stroke weight. No hand-drawn glyphs, no emoji as
  icons.
- A few inks and one accent (the teal). Red and amber mean status and nothing
  else.
- No redundant borders: try the fill alone first.
- Quiet is not faint: text and controls pass contrast (4.5:1) on the real ground.
- An urgent card is lifted the way the product lifts things, not ringed in a glow.
- A filled button keeps its colour on hover. Nothing translucent overlaps.

**Phone**
- A fresh load at 375 and 390, and a resize between.
- Tap targets 44px or more. No sideways scroll. Nothing under a fixed bar.
- A phone layout is its own design, not the desktop squeezed.

## The report

A ranked list. Each item: the screenshot, what is wrong, the fix in one line.
Then the top three changes for the phone and the top three for desktop. If
nothing: say "nothing" and list the screenshots looked at.
