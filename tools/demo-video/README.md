# Demo Video

A code-rendered, ChatGPT-style demo of the hosted MCP connector (mcp.drstanfield.com),
built with Remotion. It shows a fake chat session asking the connector about ApoB
trend, plan suggestions, and other health suggestions, and answers streaming back
with charts, citations, and tool calls. No real chat product or model is recorded —
every frame is drawn from data and animated in code.

## Storyboard (five beats, about 40 s)

Import flows lead; the ApoB beats follow. Chat title: "Import my lab files".

- A. Drag route — an attached "health.zip" chip and "Import this file into my health
  record." An `import_documents` tool row (spinner, then check), a one-line answer, and
  a compact File / Result table: four fictional files with statuses ("12 values, 3 new",
  "8 values, already recorded", "Clinic letter, filed", "1 value differs"). "Save the 3
  new values and file the letter?" — "Yes" — a second `import_documents commit` row —
  "Saved 3 values and 1 letter to your health record."
- B. Folder route — "Import the lab files in my Health by Dr Brad folder in Dropbox."
  Tool row, one-liner, a two-row table ("10 values, 10 new", "Filed"), and it ends on
  "Nothing has been saved yet. Want me to save them?" No second commit.
1. "What's the trend in my ApoB?" — a tool call, then a streamed answer with a chart.
2. "What does my plan say to reduce my ApoB?" — tool call, streamed answer, a card
   of plan text with citations.
3. "Based on my medical record, what other suggestions are there to improve my
   health?" — tool call, streamed answer, three suggestion cards.

The table wording in A and B mirrors the real `import_documents` result shape
(`packages/health-core/src/mcp-tools.ts`): per-file status (`extracted` /
`already_imported`), candidate slot state (`free` / `held_equal` / `held_different`)
and `documents[]` for filed letters. File names and counts are invented; no lab values
are shown.

Stills for the two import beats: `npx remotion still src/index.ts ApobDemo out/beatA.png --frame=170`
and `--frame=430` for `out/beatB.png`.

## Install and render

```bash
cd tools/demo-video
npm install
npx remotion render src/index.ts ApobDemo out/apob-demo.mp4 --codec h264
```

For a still frame (e.g. a thumbnail):

```bash
npx remotion still src/index.ts ApobDemo out/still.png --frame=300
```

`npm install` and `out/` are gitignored here. The last rendered file is checked
into `renders/` (one file, replaced or added to as new renders happen), so the
video is always available without re-rendering.

## Where the data comes from

- `record.json` is a fictional health record — no real patient data.
- `plan.json`, `plan-base.json`, and `src/plan-data.json` are the output of
  `npx tsx tools/get-plan.ts record.json --json` run against `record.json`. They
  are generated, not hand-edited. Regenerate them whenever the plan engine
  (health-core suggestions/evidence) changes, so the demo never shows stale
  reasoning or citations.

## Trademark rule

No OpenAI or ChatGPT logos or wordmarks anywhere in this project — the chat
chrome is a generic, unbranded look-alike, not a copy of a real product's marks.
