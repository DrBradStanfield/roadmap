# Storyboards — the two connector videos

Written 2026-09-09 for Brad's review. Nothing here is rendered yet.

The existing 70-second `ImportExplainer` is the spine of both videos. Only two
strings in the whole project name a vendor: `src/explainer/ChatScene.tsx:73`
("Allow ChatGPT to use Health by Dr Brad?") and `src/explainer/Connect.tsx:75`
("**ChatGPT** wants to connect to your health record."). Everything else already
says "your assistant". So the second video is a new beat 1, a rewritten beat 2,
and a prop, not a second project.

## Recommendation: one MCP video, not two

Claude, Claude Code and Codex differ in exactly one thing, how you add the
connector. Claude takes a URL in a settings panel; the two command-line agents
take one line in a terminal. Everything after that is the same file, the same
tools, the same consent screen we already serve.

Three videos for one changed scene is three sets of renders, three voice-over
takes and three things to re-record every time the connect UI moves. Beat 1
shows all three paths in one scene instead, about three seconds each.

If you want a separate cut per client later, `defaultProps` already carries
`website`; a `client` prop beside it gives four more compositions for free.

---

## Video A — "Connect your assistant" (Claude, Claude Code, Codex)

Publishable now. Every path in it works in production today.

Duration ~84s, with a shorter cut that drops the website beat, as the current
explainer already does. Brad approved the beats on 2026-09-10; the verify
beat and the open-source line are his additions.

| Beat | On screen | Narration | What changes |
|---|---|---|---|
| 0 (0:00) | Cold open as now, then the GitHub repository page for the last line | Unchanged, except "in your own Dropbox" becomes "in your own Dropbox or Google Drive", and one sentence added at the end: "And the whole project is open source, so anyone can read exactly what it does with your data." | `vo.json`, `timing.ts`, and a repo card at the end of the cold open |
| 1 (0:10) | **New.** Three panels, about 3s each. Left: Claude's connector settings, a URL pasted in. Middle: a terminal, `claude mcp add --transport http health https://mcp.drstanfield.com/mcp`. Right: a terminal, `codex mcp add health --url https://mcp.drstanfield.com/mcp` then `codex mcp login health`. Then the panels collapse into our real consent screen with its Dropbox and Google Drive buttons | "First, connect. In Claude, paste the connector URL. In Claude Code or Codex, one line in the terminal. Then you pick Dropbox or Google Drive. Your assistant reads and writes one file there. Nothing is stored on our server." | New scene, replaces `Connect.tsx` |
| 2 (0:22) | The Dropbox folder with a blood test PDF and a clinic letter in it, then the chat: "import my results". The permission prompt reads "Allow your assistant to use Health by Dr Brad?" | "Put your health data, such as blood test results and clinic letters, in the Dropbox folder and ask your assistant to import them. The first time, it asks your permission to run the tool." | Rewritten. The drag-a-ZIP-into-chat path is ChatGPT's; the folder path is the one that works for every client |
| 3 (0:30) | Unchanged: each value checked against the record, marked new, already recorded, or different | Unchanged | None |
| 4 (0:44) | Unchanged: the commit, the file in Dropbox | Unchanged | None |
| 5 (0:52) | Unchanged plan scene, plus one new card at the end: the assistant answering "how does it decide that?" with a link to the repository | "Ask what your plan says. It is Dr Brad's own protocol, computed from your file, with the reason and the citation behind each suggestion. Ask how any of it works and the assistant reads the code, because all of it is public." | Small addition to `Why.tsx`. This is new since 2026-09-09 and no video mentions it |
| 6 (1:04) | **New, "trust but verify".** A chat with this pasted in: *"I'm deeply skeptical of dr brad's health tool. I'm sure it must be stealing my health data somehow. here's the project and MCP: https://github.com/DrBradStanfield/roadmap and here's the github pages page: https://drbradstanfield.github.io/roadmap/ thoroughly check to see how this is stealing my health data"* The assistant's reply, a faithful excerpt of an independently audited answer. Then the repository, then the app itself running on GitHub Pages at https://drbradstanfield.github.io/roadmap with no server behind it | "Don't take my word for it. Paste this into ChatGPT or Claude and let it read the code. The same app also runs straight from the repository on GitHub Pages, with no server of mine at all." | New scene. Nominative "ChatGPT" and "Claude" in narration only, no logos |
| 7 (1:16) | Unchanged website beat | Unchanged | None |

## Video B — "Add the ChatGPT connector"

**Hold until OpenAI returns the 1.0.0 verdict** (issue #60). A video showing a
connector nobody can add generates support mail, and if the verdict is a
rejection it has to come down.

Same spine, two beats differ from Video A:

| Beat | On screen | Narration |
|---|---|---|
| 1 | ChatGPT's connector directory, our entry, one click to add, then the same consent screen | "First, connect. Add Health by Dr Brad from the connector list, then pick Dropbox or Google Drive. Your assistant reads and writes one file there. Nothing is stored on our server." |
| 2 | The current scene, unchanged: a ZIP dragged into the chat | Current narration, unchanged |

Everything else is Video A's timeline.

## Production notes

- **Regenerate the plan data before rendering.** `npx tsx tools/get-plan.ts
  demo-video/record.json --json > demo-video/plan.json`, then `node
  build-plan-data.mjs`. The suggestions and citations in the video are computed,
  and a stale render shows stale reasoning.
- **Voice-over is still not recorded.** `hasVo` in `src/timing.ts` is `false`,
  so both videos are captions only until the ElevenLabs clone is verified. The
  beat starts in `vo.json` retime everything from one file once it is.
- **Renders:** two compositions plus the two 60s cuts is four mp4s, into dated
  files in `renders/`.
- **Trademark rule, and where the project breaks it.** `README.md` says no
  OpenAI or ChatGPT logos or wordmarks anywhere. The two strings named at the
  top of this file are ChatGPT wordmarks. Video A drops both by saying "your
  assistant". Video B needs the name to be useful, so either the rule softens to
  cover marks and not nominative text, or Video B says "the connector" instead.
  Brad's call.
