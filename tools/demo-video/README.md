# Demo Video

A code-rendered, ChatGPT-style demo of the hosted MCP connector (mcp.drstanfield.com),
built with Remotion. It shows a fake chat session asking the connector about ApoB
trend, plan suggestions, and other health suggestions, and answers streaming back
with charts, citations, and tool calls. No real chat product or model is recorded —
every frame is drawn from data and animated in code.

## Storyboard (three beats)

1. "What's the trend in my ApoB?" — a tool call, then a streamed answer with a chart.
2. "What does my plan say to reduce my ApoB?" — tool call, streamed answer, a card
   of plan text with citations.
3. "Based on my medical record, what other suggestions are there to improve my
   health?" — tool call, streamed answer, three suggestion cards.

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
