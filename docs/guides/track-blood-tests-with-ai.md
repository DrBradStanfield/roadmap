---
title: "Track your blood tests over time with ChatGPT or Claude"
description: "Keep every blood test in one file in your own Dropbox or Google Drive, connect ChatGPT or Claude to it, and ask how a result has changed."
slug: "track-blood-tests-with-ai"
updated: "2026-10-22"
stories: ["US-07", "US-09", "US-12", "US-32", "US-36", "US-38"]
---

Most people's blood tests are scattered. One result is a PDF in an email. Another sits in a lab portal. You can paste a report into ChatGPT or Claude and ask what it means. But a chat is a poor place to keep years of results. Next time you have to find the old reports and paste them in again before you can ask whether a number is going up or down.

Health by Dr Brad keeps your results in one place you own, and lets your assistant read and add to it.

## What it is

Your record is one file, `health-roadmap.json`, in your own Dropbox or Google Drive. It holds your blood test results, your measurements, your medications and your screening answers, each with its date. It is plain JSON, so any program that reads text can open it. Our server never stores a copy.

Three things read and write that same file:

- [The web tool](https://drstanfield.com/pages/roadmap), where you can type values, upload a lab report and see your plan.
- ChatGPT or Claude in a browser, through a connector we run at `mcp.drstanfield.com`.
- An AI on your own computer, such as Claude Desktop or Claude Code, which opens the file directly.

Your plan is worked out from the record: suggestions drawn from published guidelines, each with its reason and citations. The web tool and the connector show the same plan.

It is free, and you do not create an account. The code is public under the MIT licence at [github.com/DrBradStanfield/roadmap](https://github.com/DrBradStanfield/roadmap). The longer introduction is [an open-source health record you can connect to your AI](/blogs/guides/ai-health-record).

## Step 1: Start your record

Open [the tool](https://drstanfield.com/pages/roadmap) and enter your sex, height and weight. A button then appears at the top of your plan, which on a phone is the Plan tab. It says "Where do you want to keep your health record?" Click it and pick Dropbox or Google Drive. When the cloud connects, the tool copies what you entered into a new file in your cloud folder.

Until you connect a cloud, the tool keeps your record in your browser only, and no assistant can reach it. [Find your health record file](/blogs/guides/find-your-record) shows where the file lands in each cloud.

## Step 2: Connect your assistant

Both assistants ask for the same address:

```copy-box
https://mcp.drstanfield.com/mcp
```

### Claude

In claude.ai, open Settings, then Connectors, then Add custom connector. Name it Health by Dr Brad, paste the address and press Add, then Connect. Approve it in Dropbox or Google Drive. On Google's screen, tick the Google Drive box, as [connect Google Drive](/blogs/guides/connect-google-drive) shows. It works on any Claude plan, with nothing to install. The full steps are in [connect Claude on the web](/blogs/guides/ai-health-record#connect-claude-on-the-web).

### ChatGPT

You need a paid ChatGPT plan, on the web. OpenAI has not published our app yet, so today you add it in developer mode: switch on developer mode, create the app with the address above, and sign in with Dropbox or Google Drive. ChatGPT asks you to pick the app again in each new chat. The steps, and what to do when one goes wrong, are in [connect ChatGPT to your health record](/blogs/guides/connect-chatgpt).

You authorize the connector once. After 90 days it asks again.

### On your own computer

If you would rather no server of ours saw your record at all, run the same tools on your own computer instead: [connect Claude Desktop or Claude Code](/blogs/guides/connect-claude), or [the command line](/blogs/guides/command-line). Those need your cloud folder synced to disk.

## Step 3: Add your blood tests

There are two main ways to get a lab report into your record.

In the chat, drop in a PDF or a photo of the report and ask your assistant to file it. The assistant reads the file itself and sends our server only the values it read: the test name as printed, the number, the unit and the date. Our server checks each value against the record's list of tests, units and ranges. You see the candidate values first. Nothing is written until you confirm.

On the website, upload the report under Blood Test Results. The tool shows what it read in a table, and you check it against the report before you press Save. The details, including file types and limits, are in [upload a lab report](/blogs/guides/upload-lab-report).

With a Dropbox record, you can also put lab files in your Dropbox folder and ask the assistant to import them. Those files go through our server to Anthropic's API to be read. The [ChatGPT guide](/blogs/guides/connect-chatgpt#what-it-can-do) explains that path.

Check what gets filed. An AI can misread a lab report the same way a person can.

## Step 4: Ask for the trend

Start a chat, turn the connector on, and say "read my record". Then ask about one test over time:

- "What has my LDL done over my last four tests?"
- "Show my HbA1c results by date."
- "Which of my results changed most since last year?"
- "Is my blood pressure going the right way?"

The assistant reads every value in the file, including ones the web tool does not show on its front page. It can ask for one test, or only the results since a date, instead of the whole record. Because the record lives in your cloud, a new chat starts from the same history. So does the other assistant, or the website.

## Step 5: Get your plan

Ask "what does my plan say?" or "what does my plan say about my LDL?". The assistant works out the same plan the web tool shows, with the reason and the citations behind each suggestion. You can also see it any time on [the tool page](https://drstanfield.com/pages/roadmap).

The plan is educational information, not medical advice. It does not replace your doctor, and it is not a diagnosis.

## What it will not do

It never deletes a value. There is no delete tool. If a number went in wrong, the assistant adds the right number as a new entry and marks the old one as entered in error. Both stay in your file, so you can always see what was there before. The connector corrects only values from the last 90 days. You fix an older one on the website, the same way: [how to fix a value](/blogs/guides/upload-lab-report#fix-a-value-after-saving).

It holds one value per test per day. Asking for a second LDL on a day that already has one is refused, and the assistant is told to make a correction instead.

It cannot change your medications or screenings. You update those on the website.

A Google Drive record works with files dropped into the chat and with the website upload, but not with the folder import.

## What our server sees

To answer one request, the connector opens your folder with the credential you approved and holds your record in memory for that request. It reads it, but it stores none of it and keeps no copy. You cancel it in your own cloud settings: [dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps) or [myaccount.google.com/connections](https://myaccount.google.com/connections). The connector and the website use the same app at your provider, so cancelling it there also disconnects this website from your record. The tool asks you to connect again next time you open it. The [Connector Privacy Notice](https://drstanfield.com/pages/connector-privacy) has the detail.

## If you get stuck

Ask the chat on [the tool page](https://drstanfield.com/pages/roadmap). On a phone it is the Chat tab. Or open an issue at [github.com/DrBradStanfield/roadmap/issues](https://github.com/DrBradStanfield/roadmap/issues). Issues are public, so leave out your values.
