# Dismissing "Reduce alcohol": plan (draft, 2026-10-30)

Story: US-60 in [user-stories.md](../user-stories.md). Raised by a TestFlight tester who
does not drink and saw "Reduce alcohol intake" on his plan, with no way to remove it.

## What happens today

`suggestions.ts` shows `reduce-alcohol` (attention) when BMI is 30 or more, or BMI is over
25 with a waist-to-height ratio of 0.5 or more, or triglycerides are 1.7 mmol/L (150 mg/dL)
or more. The engine never knows whether the person drinks. Two other cards mention
alcohol: "Reduce triglycerides with diet" ("limit alcohol") and the very-high triglycerides
card ("strict alcohol and sugar avoidance"). No suggestion can be dismissed, on the web or
the iPhone.

## The flow

1. The "Reduce alcohol intake" card has a Dismiss button (web and iPhone).
2. Dismiss asks one question: "Do you drink alcohol?" with two answers, "I don't drink"
   and "I drink".
3. The answer goes into the record, so every device and the website know it.
4. The engine reads the answer. "I don't drink" removes the card for good.
5. The answer shows in About you (web and iPhone), where it can be changed. That is the
   undo.

## Data and merge

- **Where:** one new field on the profile, `alcohol: 'none' | 'drinks'`. The profile is
  already merged field by field, newest write wins (`mergeFields`, US-10 AC8), so this needs
  no new merge code. The last answer given on any device wins.
- **Why not a general "dismissed suggestions" list:** a list would let someone hide a
  statin or a screening suggestion with one tap, and it needs its own merge rules. The
  question answers the real problem (the engine does not know). A general dismiss can be its
  own story later.
- **Older copies of the app:** `mergeFields` keeps every field it finds, known or not, so an
  older website tab or iPhone engine keeps the answer when it saves. It just does not use it,
  so the card shows again on that copy until it updates. The iPhone engine updates over the
  air (D3). A test proves an older engine's save keeps the field.
- **Erase:** "Delete all my data" clears the profile, so the answer goes with it.
- **Agents:** the MCP tools read the record as it is, so they see the field. No change to
  the MCP server.

## Engine (clinical, three-file sync)

- `types.ts`: `alcohol?: 'none' | 'drinks'` on the inputs; `mappings.ts` copies it from the
  profile, with a round-trip test.
- `suggestions.ts`: `reduce-alcohol` is skipped when `alcohol === 'none'`.
- If Brad agrees (call C2), the triglycerides diet card drops "limit alcohol" for a
  non-drinker.
- `health_roadmap_algorithm.md` gets the new condition in the `reduce-alcohol` row, and the
  triglycerides row if C2 is yes. `evidence.ts` and `roadmap_text.html` change only if C2
  changes wording they hold. Otherwise they stay as they are, and the commit says why.
- Chat: the record summary the chat receives (`chat-context.ts`) carries the answer, so
  the chat stops telling a non-drinker to cut down.

## Screens

- **Web:** a Dismiss button on the card (`ResultsPanel.tsx` `SuggestionCard`), a small
  dialog with the question, and an Alcohol row in About you (`InputPanel.tsx`).
- **iPhone:** a Dismiss button on the card (`PlanCardView.swift`), a sheet with the
  question, and an Alcohol row in My data's About you. The engine is the single source:
  Swift only shows the card the engine sends and writes the answer through the existing
  profile save.
- After "I don't drink" the card fades out, as other cards do when they leave the plan.

## Usage signal

A `product_events` event `alcohol_question_answered` on the web, and a Clarity event
"Alcohol answered" on the iPhone. Neither carries the answer: whether someone drinks is
health information, and health values never go into telemetry.

## Calls for Brad

Clinical:

- **C1. Answers.** Two answers ("I don't drink", "I drink"), or a frequency scale?
  Recommendation: two. The engine has one rule, and a scale invites advice we do not give.
- **C2. The triglycerides diet card.** For a non-drinker, drop "limit alcohol" from its text?
  Recommendation: yes. It is the same wrong advice in a second place. It means a text
  variant in suggestions.ts and the algorithm.
- **C3. The very-high triglycerides card (pancreatitis risk).** Keep "strict alcohol and
  sugar avoidance" for everyone? Recommendation: keep. It is an urgent safety card, and the
  advice does no harm to a non-drinker.
- **C4. "I drink."** Should the card stay, or hide anyway?
  - Recommendation: it stays. The advice applies, and the person has seen that we
    asked.
  - The alternative: hide it for six months, then show it again. That needs a date
    on the profile and a re-show rule.
- **C5. Asking again.** Never ask on our own; the answer stays until the person changes
  it in About you. Recommendation: yes. A re-ask after a year could come later.

Data:

- **M1. The profile field** (newest answer wins, no new merge code) over a general
  dismissed-suggestions list. Recommendation: the field.
- **M2. "Not answered".** About you offers "Not answered" as well, which clears the field
  and brings the card back. Recommendation: yes, so a mistaken tap can be fully undone.
  A test checks that clearing merges the same way as setting.

## Build order and reviews

1. Brad answers C1 to C5, M1 and M2.
2. Engine and record: types, mappings, suggestions, chat context, three clinical files,
   tests (health-core, round trip, merge of set and cleared, older engine keeps the
   field).
3. Web screens, then iPhone screens, each with tests and screenshots (web: Chrome and
   real WebKit; iPhone: simulator, light and dark).
4. /simplify, then a fresh Opus adversary and Codex (gpt-6.1-sol), one full round and
   one fix-scoped re-check. Clinical and merge changes need both.
5. `test:all`, deploy the web, release the engine, and the iPhone screens go in the next
   build.
