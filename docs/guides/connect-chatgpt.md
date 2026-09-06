---
title: "Connect ChatGPT to your health record"
description: "Add the Health by Dr Brad connector to ChatGPT on the web, and it can read your blood tests, work out your plan and file new results."
slug: "connect-chatgpt"
updated: "2026-09-02"
stories: ["US-32"]
---

Your record from the Health by Dr Brad tool is one file, `health-roadmap.json`, in your own Dropbox. ChatGPT in a browser cannot open a file on your computer, so we run a small connector between the two. You authorize it once and ChatGPT can then read your results, work out your plan and add new values, from your phone or any browser.

This takes about five minutes. Everything happens in ChatGPT's own settings; there is nothing to install.

## Before you start

You need a paid ChatGPT plan on the web, and your record has to be in Dropbox or Google Drive. Those are the two clouds this works with today. A record in GitHub can only be reached by an AI running on your own computer. That path is in [how to let an AI read and update your health record](/blogs/guides/ai-health-record).

If you have never connected a cloud provider, there is no record to reach yet: the tool is holding it in your browser. Open [the tool](https://drstanfield.com/pages/roadmap), connect Dropbox or Google Drive, and save a value first.

The address ChatGPT asks for:

```copy-box
https://mcp.drstanfield.com/mcp
```

## The steps

1. Turn developer mode on. Open Settings, then Security, and switch Developer mode on.

2. Create the app. Go to Plugins and choose Create app.

3. Fill it in. Name it Health by Dr Brad. Paste the address above as the server URL. Set Authentication to OAuth. Tick the box acknowledging the risk of connecting a server, which OpenAI asks for on anything added this way. Press Create.

4. Sign in. Press Sign in with Health by Dr Brad. Our own page opens and says what the connector does. Press Continue to Dropbox. Dropbox asks whether to link the app. Approve it, and the app shows as installed.

5. Turn it on in a chat. Open the + menu, then More, then Developer mode, and pick Health by Dr Brad. ChatGPT asks for this in each conversation, so do it again in the next chat.

Then say "read my record".

## After an update

When we add a tool, ChatGPT does not see it straight away: it keeps the connector's list of tools from the last time it looked. Open Settings, then Plugins (called Connectors on some accounts), pick Health by Dr Brad, and press Refresh. Then reload the page. The new tool is there in your next chat.

## Why developer mode

OpenAI keeps a connector nobody has reviewed behind developer mode. Ours has not been through their review, so that is where it lives today. Developer mode is a setting on your own account. It does not change how ChatGPT answers you, and it does not give this connector anything beyond what you approve in Dropbox.

We intend to publish the app so this step goes away. Publication means OpenAI reviewing it against their rules, and we will say here when it happens rather than before.

Claude needs no equivalent step. If you use both, [connecting Claude](/blogs/guides/ai-health-record#connect-claude-on-the-web) is shorter.

## What it can do

It reads your record: every value in the file, including ones the tool does not show on the front page. It works out your plan, the same one the web tool shows, with the reason and the citations behind each suggestion. It adds a value, or a whole lab panel in one call, up to 50 tests. It corrects a value that went in wrong. It changes four things about you: your sex, your birth year, your birth month and your height, the four your plan is worked out from. And if a tool refuses something you reasonably expected, it reports the problem for you: a public issue on the project's GitHub, filed as you ask, carrying its description and nothing about you or your values.

It can now import lab files, too. Two ways in. In a desktop browser you can drop a
file straight into the conversation: a PDF, a JPEG or PNG photo, or a ZIP of them.
Or put the files in your Dropbox folder (`Apps/Health Plan by Dr Brad`) and ask it to
import them: it reads five folder files at a time, or one ZIP of up to twenty, and
tells you what is left. The folder route works from any device, needs no file in the
chat, and is the way round two limits of ChatGPT's own: its phone apps do not hand
files to apps yet, and its free tier pauses chats with files after a few in a row.
An iPhone HEIC photo is not read either way; share it as a JPEG, or take a screenshot.
Whatever it cannot read, it tells you why and what to do. Either way it shows you
candidate values, in the units your record uses, before anything is saved: accept the
ones that look right and it writes them, filing the document itself as a record with
no text or image kept, just its name and date. A report with no printed date is not
lost: it asks you when the test was taken and files it on that day. The file you import goes through our
server to Anthropic's API for extraction and is kept nowhere — a different path from
the website's own upload, which reads the PDF in your browser and sends only the
extracted text to our server.

Paste in a lab report and ask it to file the results. Ask what your LDL has done over four tests. Ask what your plan says to do about it.

## What it cannot do

It cannot delete anything. There is no delete tool, and no call it can make removes a row.

It cannot erase a mistake either. A correction adds a new row with the right number and marks the old row "entered-in-error", and both stay in your file for good. That is how a hospital record works, and it is why you can always see what you were told and when. A correction on a row older than 90 days is refused: old results are history, not typos.

It cannot touch your medications, supplements or screenings. Those are current state that another device can overwrite, so for now only clinical values are writable this way. Documents are the one exception, and only through import: it files what it imports as a record with a name and a date, never the text or the image itself, and the original file stays wherever you put it.

It can change four things about you: your sex, your birth year, your birth month and your height. Your plan is worked out from those, so a wrong one makes the whole plan wrong, and "my height is 165, not 178" should not need a trip to the website. These four are not kept in history the way a blood test is: the newest write is the one your record keeps, so if you change your height on the website and ask ChatGPT to change it in the same minute, the later of the two is what you end up with. Before it changes one, ChatGPT has to say what it believes the field holds now, and it is refused if it has that wrong. It cannot change how the site displays units.

It cannot add a second value for a test on a day that already has one. That call is refused by name, and the refusal tells ChatGPT to make a correction instead of an overwrite.

It cannot see the token that runs your email reminders, if you use them. That token is stripped out of every read, so it can never reach a chat transcript.

## What we can see

Your record still lives only in your Dropbox. Our server reads it, in memory, to answer ChatGPT, and keeps no copy. We store nothing about you: no account, no row, no session. What ChatGPT holds is a sealed credential that only we can open, and what we hold is the key and no credential.

Check what it files. An AI can misread a lab report the same way a person can, and the record is yours, so the last look at a new value should be yours too.

Take care with the web tool open in another tab while ChatGPT is writing. The page now notices a change and re-reads your record within seconds, and sooner when you switch back to that tab, so what you are looking at catches up on its own. But there is still no lock: a value you are typing at that moment and a value ChatGPT is writing at that moment can still collide, and one of the two loses.

## How to cancel it

Go to [dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps) and unlink Health by Dr Brad. That is the real switch, and it is yours, not ours. The [Connector Privacy Notice](https://drstanfield.com/pages/connector-privacy) explains what the connector stores, which is nothing, and how to disconnect.

One thing to know before you press it: Dropbox ties the folder to the app, so unlinking also disconnects this website from your record. The tool will ask you to connect Dropbox again next time you open it, which is one click.

Removing the app inside ChatGPT stops ChatGPT reaching the connector, which is worth doing too. It does not unlink Dropbox by itself.

## If something goes wrong

The connector does not appear in a chat: developer mode is per conversation. Open the + menu, then More, then Developer mode, and pick it again.

ChatGPT says it cannot find your record: open [the tool](https://drstanfield.com/pages/roadmap) and check Dropbox is connected and a value is saved. The connector reads the same file the tool writes.

Something looks wrong in your data: open the tool and correct the value there. The app appends the correction and marks the old row as an error, which is the safest undo you have.

Anything else: ask ChatGPT to report the problem and it files a bug report for you, as a public issue on the project's GitHub carrying its description and nothing about you. Or open an issue at [github.com/DrBradStanfield/roadmap/issues](https://github.com/DrBradStanfield/roadmap/issues), or open the chat bubble on any page of this site and ask.
