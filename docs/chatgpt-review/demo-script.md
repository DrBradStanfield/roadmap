# Demo recording script (ChatGPT app 1.0.2)

OpenAI asks for a recording that will "demonstrate the test cases and plugin functionality". Its
URL goes in `extensions.com.openai.review.demo_recording_url` in `plugin/plugin.json`, then the ZIP is
rebuilt and uploaded again. The video sits at an unlisted CDN URL: anyone holding the link can watch
it, so it shows invented data only.

It is a real screen recording of a live ChatGPT session, never an animation: the reviewer must see
the app working. It uses a ChatGPT developer-mode connection to the same server the plugin points
to, and says so. Long model waits are cut, and the narration says that too. Brad's ElevenLabs voice
clone narrates it (`demo/narration.json`, `demo/tts.mjs`); the end card says the voice-over was
generated from his own voice.

It is also proof run 1 ([listing, fixture step 1](../chatgpt-app-listing.md)), so it shows each
first-time path; run 2 repeats it word for word.

## Before recording (each one is a gate)

1. **The reviewer sign-in is live:** the three `MCP_REVIEWER_*` secrets set and deployed, and
   `tools/mcp-reviewer-check.mjs` passes. Never re-run `--password` or `--mint` after this: either
   one changes the generation and ends every reviewer session, this one included.
2. **Nothing of Brad's can reach the screen.** Brad's existing developer app "Health Roadmap"
   reaches his real Dropbox, with the same nine tool names on the same URL, so ChatGPT could call it
   instead. Brad disconnects or disables it for the session, turns off ChatGPT memory and chat-history
   reference (his real values could surface from earlier chats), turns off his other ChatGPT apps, and turns on Do Not Disturb. The
   sidebar stays closed: it lists his own chats.
3. **The demo app.** ChatGPT → Settings → Apps → developer mode → create "Health by Dr Brad" with
   `https://mcp.drstanfield.com/mcp`, and stop before Connect.
4. **The proof PDF exists locally:** `node docs/chatgpt-review/make-sample-lab-report.mjs --variant`
   writes `sample-lab-report-proof.pdf`. It is hosted nowhere, so nothing can attach the reviewer's
   CDN copy by mistake. Brad attaches it himself if the browser tool cannot.

## Recording

Claude brings Chrome to the front and records the page area only with `screencapture -v -R <tab
bounds>`, so the Claude extension's side panel is not captured. Brad presses Connect, types the
reviewer username and password into our box (the password field is masked) and presses Sign in;
Claude never types the password. Then Brad keeps hands off the Mac for about eight minutes while
Claude drives ChatGPT.

Brad's other ChatGPT apps are off for the session too, so a negative case cannot wander into one.
Every tool-call chip must name "Health by Dr Brad". A take is discarded, and recorded again, if any
chip names another app, any answer shows a value that is not in the reviewer record, or a negative
case calls our app (that case is then replaced in `plugin.json` before the retake). The username
Brad types is blurred in assembly; the password field is masked already.

| Segment | On screen |
| --- | --- |
| s0 | Title card. |
| s1 | Settings → Apps → Health by Dr Brad → Connect. Our page with "OpenAI app reviewers: sign in here"; hold a second, then sign in. ChatGPT shows the app connected. |
| s2 | "What's in my health record?" → profile, measurements, lab results. |
| s3 | "Record my weight on 3 March 2026 as 78 kg." → added. Not 2 March: that date is the reviewer's. |
| s4 | "What should I do next about my health?" → the plan, with reasons and citations. |
| s5 | Drop `sample-lab-report-proof.pdf`, then "Here is my blood test. Add the results to my record." → ChatGPT lists what it read; "Yes, add them."; filed. |
| s6 | "My most recent ferritin should be 10 ug/L higher than it shows." → ChatGPT shows the change; "Yes, correct it."; corrected. |
| s7 | All three negatives, each in a new chat: "Book me a flight from Auckland to Sydney next Friday.", "Write a short poem about autumn.", "Book me an appointment with a doctor near me this week." → no app call. If the third calls the app, the case is replaced in `plugin.json` before submitting. |
| s8 | Phone (below). |
| s9 | End card, with "Voice-over generated from Brad Stanfield's own voice." |

## Phone (segment s8, Brad)

OpenAI's submission-errors page asks for a recording that "shows the main use cases and tools
across supported platforms". So the video ends with about 30 seconds from the ChatGPT phone app,
on the same ChatGPT account, after the desktop take: Brad starts iOS screen recording, opens a new
chat, asks "What should I do next about my health?", lets the plan finish, stops, and AirDrops the
file to the Mac. The gates above still hold: "Health Roadmap" off, memory off, and every chip names
"Health by Dr Brad". If the phone app does not offer the developer-mode app, the fallback is
chatgpt.com in a phone-sized browser window, and the narration says "ChatGPT on a phone-sized
screen", never "the phone app".

## Assembly

`node docs/chatgpt-review/demo/tts.mjs` renders one clip per segment and exits nonzero if any
fails. ffmpeg cuts the long model waits, lays each clip at its segment and burns in captions.
Outputs stay in the gitignored `demo/audio/` and `demo/out/`. The MP4 goes to Shopify Files on the
edu store, as the sample report did, and its CDN URL goes into `plugin.json`.
