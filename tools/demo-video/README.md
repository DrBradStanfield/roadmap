# Demo Video

Code-rendered, ChatGPT-style demos of the hosted MCP connector (mcp.drstanfield.com),
built with Remotion. The main cut is a 70 s import explainer: why a structured record
beats pasting PDFs, connect, drag a ZIP in, read and check, save, ask the plan. No real
chat product or model is recorded; every frame is drawn from data and animated in code.

## Compositions

- `ImportExplainer` (70 s, 2100 frames) and `ImportExplainer60` (64 s, same cut
  without the website beat) follow storyboard revision 3 (the `Import Demo
  Storyboard`, 7 September 2026): eight beats, captions burned into a 150 px band
  at the foot of the frame, and beat starts read from `src/vo.json`.
- `ApobDemo` (40 s) is the earlier import + ApoB demo, kept as is.

### ImportExplainer beats

0. Why a record, not a paste (0 to 10 s): hook line alone, the two-column contrast
   row by row, then Brad's line held.
1. Connect (10 to 18): the consent page recreated from the live capture (heading,
   lede, "ChatGPT wants to connect", two teal buttons), cursor to Dropbox, a blurred
   Dropbox permission placeholder, back to the chat.
2. Drag your health data in (18 to 26): file chip, bubble, the permission card
   "Allow ChatGPT to use Health by Dr Brad?" with the tool's own first line as its
   second sentence (`packages/health-core/src/mcp-tools.ts`); "Always allow" chosen.
3. Read and check (26 to 40): tool row, answer, four-row File / Result table, then
   the assistant's question.
4. Saved (40 to 48): "Yes", commit row, result.
5. What does my plan say now? (48 to 60): the ezetimibe card from real `get_plan`
   output, title, description and first citation verbatim.
6. The website (60 to 66; cut in the 60 s version): a stylised, clearly-mock results
   matrix built from `record.json` only, with "Same file. Same record." over it.
7. Close (last 4 s).

Every scene lives in `src/explainer/`; `src/timing.ts` holds the beat starts and the
caption chunks (at most two lines each); `src/ui.tsx` holds the caption band and cursor.

### Voice-over hook

`src/vo.json` is an array of `{beat, start, text}`: the caption script per beat and its
start in seconds (beat 8 is the end marker). The compositions take their beat timings
from it, so once a voice track exists, align each beat's `start` to the sentence that
introduces it and the video follows the audio. Put the track at `public/vo.mp3` and
flip `hasVo` in `src/timing.ts` to true; the `<Audio>` layer is already wired. No audio
is generated here.

The table wording mirrors the real `import_documents` result shape: per-file status
(`extracted` / `already_imported`), candidate slot state (`free` / `held_equal` /
`held_different`) and `documents[]` for filed letters. File names and counts are
invented; no lab values are shown in the chat.

Stills: `npx remotion still src/index.ts ImportExplainer out/beat2.png --frame=760`
(beats 0, 1, 2, 3, 6 at frames 150, 330, 760, 1150, 1900). `./render.sh` renders both
cuts and those stills.

## Install and render

```bash
cd tools/demo-video
npm install
npx remotion render src/index.ts ImportExplainer out/import-explainer.mp4 --codec h264
npx remotion render src/index.ts ImportExplainer60 out/import-explainer-60.mp4 --codec h264
npx remotion render src/index.ts ApobDemo out/apob-demo.mp4 --codec h264
```

For a still frame (e.g. a thumbnail):

```bash
npx remotion still src/index.ts ApobDemo out/still.png --frame=300
```

`npm install` and `out/` are gitignored here. Rendered files are checked into
`renders/` (dated), so the video is always available without re-rendering.

## Where the data comes from

- `record.json` is a fictional health record — no real patient data.
- `plan.json` and `plan-base.json` are the output of
  `npx tsx tools/get-plan.ts tools/demo-video/record.json --json` (run from the repo
  root) against `record.json`; `node build-plan-data.mjs` then derives
  `src/plan-data.json` from it. All generated, never hand-edited. Regenerate before
  every render so the demo never shows stale reasoning or citations.

## Trademark rule

No OpenAI or ChatGPT logos or wordmarks anywhere in this project — the chat
chrome is a generic, unbranded look-alike, not a copy of a real product's marks.
