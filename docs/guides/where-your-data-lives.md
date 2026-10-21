---
title: "Where your health data lives"
description: "What the Health by Dr Brad tool keeps, where it keeps it and for how long, including everything that passes through our server or another company."
slug: "where-your-data-lives"
updated: "2026-10-22"
stories: ["US-09", "US-11", "US-12", "US-15", "US-17", "US-23", "US-32"]
---

Your health record in [the tool](https://drstanfield.com/pages/roadmap) is one file, `health-roadmap.json`. It holds your profile, your measurements, your blood test results, your medications and your screening answers. It lives in your own Dropbox, Google Drive or GitHub, or on a WebDAV server you run. If you connect none of them, it lives in this browser's storage. We keep no copy of it on our server.

Some features do send data to our server, or to another company. This page lists each one, what it sends and how long anything is kept.

## Your record

Your browser reads and writes the file in your cloud directly. With Dropbox, the tool can reach only its own app folder. With Google Drive, it can see only the files it created. With GitHub, it uses a token you paste, limited to one repository.

Google gives a lasting sign-in only to apps that hold a secret. So when you connect Google Drive, our server swaps Google's sign-in code for a token and hands the result straight back to your browser. It stores nothing from that exchange and does not open your Drive.

The sign-in tokens for your cloud are kept in this browser's local storage, for this site. So is a working copy of your record. To clear both from a shared computer, use Log off this device, described in [find your health record file](/blogs/guides/find-your-record#log-off-a-device).

The file is plain JSON. Its format is published as a [JSON Schema](https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/docs/health-roadmap-file.schema.json), and the tool's code is open source under the MIT licence on [GitHub](https://github.com/DrBradStanfield/roadmap), so you can check what it does.

## Lab reports you upload

Your browser reads the file first. It takes the text from a PDF, or a picture of a scanned page or photo. That goes through our server to Anthropic's API, from the company that makes Claude, which picks out the test names, numbers, units and dates. The results come back to your browser for you to check.

Our server does not store the file, its text or the values. The original file is kept only in your cloud folder, if you connected one. A large upload goes to Anthropic as one batch, and our server deletes that batch from our Anthropic account after the results reach you. If our server restarts first, the batch can stay in our Anthropic account for up to 29 days. Anthropic's own policy governs what they keep. The details, with the times and a link to that policy, are in [upload a lab report](/blogs/guides/upload-lab-report#where-your-file-goes).

## The chat on the tool page

Each message you send goes to our server with the earlier turns of the conversation and your plan: your profile, your values with their dates, your medications and your screening answers. That includes values you have typed but not yet saved. Our server passes all of it to Anthropic's API to write the answer, under the same Anthropic policy as uploads.

Your conversations are saved in your own cloud folder, as `chat-history.json`, or in this browser.

Our server keeps one row for each question, so we can check which articles the chat matched. The row holds the first 500 characters of your question with every number replaced by `#`, the articles it matched and some timings. It is tied to a random session id, not your name. That session is matched to a scrambled (hashed) form of your network address. Words stay as you typed them, so a diagnosis you write in a question stays in that text. A daily job blanks the question once the row is 30 days old. The rest of the row stays. The reply and the earlier turns are not stored.

## The chat bubble on other pages

Where the chat bubble appears on other pages of this site, it works differently. It reads the copy of your record in this browser and sends your saved values with each message, much as the tool page's chat does.

Our server stores that chat: your question and the reply, and the reply can quote your values. Once a message is 30 days old, a daily job blanks its text. The conversation's title, made of the first words of your first question, is blanked 30 days after your last message in that conversation. What stays is the shape: the ids, the times and the token counts.

## Connecting ChatGPT or Claude

If you connect an AI assistant through our connector, our server reads your record from your cloud on each request, in memory, and keeps no copy. Your assistant holds an encrypted credential for your cloud. We hold the key to it but not the credential itself. Access lasts an hour and is refreshed for up to 90 days. We keep a count of connector use: which tool, which assistant, whether it worked, and when. It holds no values.

What your assistant reads goes to its own company, OpenAI or Anthropic, under that company's policy. If you ask it to import lab files from your Dropbox folder, those files go to Anthropic's API the same way uploads do. The full account is in the [connector privacy notice](https://drstanfield.com/pages/connector-privacy).

If you would rather our server never saw your record, the same tools run on your own computer, straight against your file: see [connect Claude](/blogs/guides/connect-claude) and [the command line](/blogs/guides/command-line).

## Email

Connecting a cloud on this website turns on check-up reminders, unless you switched them off before. Our server then receives the email address from your cloud account, the names of the check-ups and blood tests that are due, and their dates. It receives no results. Every reminder has a one-click off link. When you turn reminders off, the schedule is emptied, and the row with your address is deleted 90 days later.

Typing your email into the box beside your plan does the same, and also adds you to a mailing list, which the note beside the box names. That list is held by Klaviyo. Our emails are sent through Resend.

The feedback box stores your email address and your message, up to 2,000 characters, and emails both to Dr Brad. If you are signed in on this site, it adds your customer number. Nothing deletes that row, so leave health details out of feedback.

## Usage counts, recordings and error reports

The page counts what people use, so we can tell which features to keep. Each event is a fixed name with a few fixed labels, such as which cloud you picked, plus a random visitor id kept in this browser. Free text and the numbers you type are rejected. A few events name a blood test, such as one whose unit the tool could not read, but not its value.

The site uses Microsoft Clarity, which records how visitors move around a page. We mark the tool, the chat and the upload window for Clarity to mask, so their text, including your values, is hidden in those recordings.

Errors are reported to Sentry. Before a report leaves your browser or our server, our code removes request bodies and cookies, known health and identity fields, and numbers that sit next to a unit or a test name. It cannot recognise a diagnosis written in plain words.

Requests from the tool reach our server through Shopify, which hosts this site. Our server runs on Fly.io in the United States.

## Delete your data

Use the Delete All My Data button at the bottom of your plan. It erases your health record and chat history in this browser and in your connected cloud, and turns off reminders. A few things are out of its reach, including your uploaded files, your provider's version history and our 30-day chat text. [Find your health record file](/blogs/guides/find-your-record#delete-your-data) lists them all and says how to remove each one.

To cut the tool off from your cloud, remove the app in your provider's settings: [dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps) for Dropbox, [myaccount.google.com/connections](https://myaccount.google.com/connections) for Google Drive. That also disconnects any AI assistant you connected through us.

## If you get stuck

Ask the chat on the tool page. On a phone it is the Chat tab.
