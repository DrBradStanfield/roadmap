# Demo recording script (ChatGPT app 1.0.2)

OpenAI requires a walkthrough that "demonstrates your plugin's test cases and functionality". Its
URL goes in `extensions.com.openai.review.demo_recording_url` in `plugin/plugin.json`, then the ZIP is
rebuilt and uploaded again. The video is not shared outside OpenAI.

Record after the reviewer sign-in is live (the three `MCP_REVIEWER_*` secrets set and deployed).

**Do not use the review's own inputs.** The reviewer's record is shared, so the demo must not use up
the first-time paths of the test cases:

- Positive 2: record a weight on a DIFFERENT date (for example 3 March 2026), not 2 March.
- Positive 4: drop `sample-lab-report-proof.pdf` (made with
  `node docs/chatgpt-review/make-sample-lab-report.mjs --variant`), never `sample-lab-report.pdf`.

## Setup (about 1 minute on screen)

1. Start a screen recording (Cmd+Shift+5, record the browser window) at ChatGPT on the desktop.
2. Settings → Apps → Health by Dr Brad → Connect.
3. Our page opens with "OpenAI app reviewers: sign in here". Type the reviewer username and password,
   press Sign in. ChatGPT shows the app connected. (Pause a second on our page so the box is visible.)

## The cases (about 3 minutes)

Type each prompt; let ChatGPT finish and show the tool call before moving on.

1. "What's in my health record?" → the profile, measurements and lab results.
2. "Record my weight on 3 March 2026 as 78 kg." → added. (Same tool as positive 2.)
3. "What should I do next about my health?" → the plan, with reasons and citations.
4. Drop `sample-lab-report-proof.pdf`, then "Here is my blood test. Add the results to my record."
   → ChatGPT lists what it read; say yes; the results are filed.
5. "My most recent ferritin should be 10 ug/L higher than it shows." → ChatGPT shows the change;
   say yes; the value is corrected.
6. One negative: "Write a short poem about autumn." → ChatGPT answers without the app.

## Phone (about 30 seconds)

OpenAI asks for the main use cases "across supported platforms". On the ChatGPT phone app, with the
same account, ask "What should I do next about my health?" and show the plan.

## Upload

Upload the recording to Google Drive (or YouTube, unlisted), set sharing to "anyone with the link",
and send the link. It goes into `plugin.json`, and the ZIP is rebuilt and uploaded.
