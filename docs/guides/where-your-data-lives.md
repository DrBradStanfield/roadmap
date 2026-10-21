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

Your browser reads and writes the file in your cloud directly. With Dropbox, the tool can reach only its own app folder. With Google Drive, it can see only the files it created. With GitHub, it uses a token you create, which we ask you to limit to one repository.

Google gives a lasting sign-in only to apps that hold a secret. So when you connect Google Drive, our server swaps Google's sign-in code for a token and hands the result straight back to your browser. While you use the tool, your browser sends that token back through our server about once an hour to get a fresh one. Our server stores nothing from either exchange and does not open your Drive.

The sign-in tokens for your cloud are kept in this browser's local storage, for this site. So is a working copy of your record. To clear both from a shared computer, use Log off this device, described in [find your health record file](/blogs/guides/find-your-record#log-off-a-device).

The file is plain JSON. Its format is published as a [JSON Schema](https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/docs/health-roadmap-file.schema.json), and the tool's code is open source under the MIT licence on [GitHub](https://github.com/DrBradStanfield/roadmap), so you can check what it does.

## What our server keeps, and where

Our server keeps its rows in a database run by Supabase. Every row this page says our server keeps is held there: chat questions and replies, chat sessions, reminder sign-ups, feedback, usage counts, an audit log and customer account rows.

Our server also sees your network (IP) address on every request. It uses it in memory to limit how often one address can call us. Only the chat stores it, and only in a scrambled (hashed) form.

When a daily job blanks text, the text can survive in Supabase's backups for a while after that. We have not yet confirmed how long those backups last.

## Lab reports you upload

Your browser reads the file first. It takes the text from a PDF, or a picture of a scanned page or photo. That goes through our server to Anthropic's API, from the company that makes Claude, which picks out the test names, numbers, units and dates. The results come back to your browser for you to check.

Our server does not store the file, its text or the values. The original file is kept only in your cloud folder, if you connected one. A large upload goes to Anthropic as one batch, and our server deletes that batch from our Anthropic account after the results reach you. If our server restarts first, the batch can stay in our Anthropic account for up to 29 days. Anthropic's own policy governs what they keep. The details, with the times and a link to that policy, are in [upload a lab report](/blogs/guides/upload-lab-report#where-your-file-goes).

## The chat on the tool page

Each message you send goes to our server with the earlier turns of the conversation and your plan: your profile, your values with their dates, your medications and your screening answers. That includes values you have typed but not yet saved. Our server passes all of it to Anthropic's API to write the answer, under the same Anthropic policy as uploads.

Your conversations are saved in your own cloud folder, as `chat-history.json`, or in this browser.

Our server keeps one row for each question, so we can check which articles the chat matched. The row holds the first 500 characters of your question with every number value replaced by `#`, the articles it matched, how the question was classified and some timings. Test names that contain a digit, such as HbA1c, stay as written. Words stay as you typed them too, so a diagnosis you write in a question stays in that text. A daily job blanks the question 30 days after the row was made. The rest of the row stays. The reply and the earlier turns are not stored.

If you are not signed in to this site, the row is tied to a random session id, not your name. That session is stored with a scrambled form of your network address. Nothing deletes the session row.

If you are signed in to this site, each message also makes our server look up your email address and your first and last name from your store account. The first time, it creates an account row for you in our database with those details, and an audit entry saying it did. Later messages keep the names up to date. Your questions are still stored as above, under a random session id. The 30-day job and Delete All My Data do not remove your account row.

## The chat bubble on other pages

Where the chat bubble appears on other pages of this site, it works differently. It reads the copy of your record in this browser and sends your saved values with each message, much as the tool page's chat does.

Our server stores that chat: your question and the reply, and the reply can quote your values. Your questions are not masked here: numbers stay as you typed them. A daily job blanks each message's text 30 days after that message. The conversation's title, made of the first words of your first question, is blanked 30 days after your last message in that conversation. Our server also keeps a row for each question, as on the tool page. That row holds your question unmasked, with up to four of your earlier questions, and its text is blanked 30 days after the row was made. What stays is the shape: the ids, the times and the token counts.

If you are not signed in, the chat is tied to a random session id, stored with a scrambled form of your network address. If you are signed in, our server looks up your email address and name as on the tool page, and stores the conversation under your account row. It also sends a summary of your recent orders on this store to Anthropic with each message, so the chat can answer questions about them.

## Connecting ChatGPT or Claude

If you connect an AI assistant through our connector, our server reads your record from your cloud on each request, in memory, and keeps no copy. Your assistant holds an encrypted credential for your cloud. We hold the key to it but not the credential itself. Access lasts an hour and is refreshed for up to 90 days. We keep a count of connector use: which tool, which assistant, whether it worked, and when. It holds no values.

What your assistant reads goes to its own company, OpenAI or Anthropic, under that company's policy. If you ask it to import lab files from your Dropbox folder, those files go to Anthropic's API the same way uploads do. The full account is in the [connector privacy notice](https://drstanfield.com/pages/connector-privacy).

If you ask your assistant to report a bug, our server files it as a public issue on the project's GitHub page. It holds the assistant's description of the problem. The tool refuses a report that looks like a health value, but it cannot spot a diagnosis written in words, so read the report before you agree.

If you would rather our server never saw your record, the same tools run on your own computer, straight against your file: see [connect Claude](/blogs/guides/connect-claude) and [the command line](/blogs/guides/command-line).

## Email

Connecting Dropbox, Google Drive or GitHub on this website turns on check-up reminders, unless you switched them off before. It does not for a WebDAV server, for anyone the tool knows is under 18, or when your provider gives us no email address. Our server then receives the email address from your cloud account, the names of the check-ups and blood tests that are due, and their dates. It receives no results. When you sign up, it sends you one email that lists that schedule. Every reminder has a one-click off link. When you turn reminders off, the schedule is emptied, and the row with your address is deleted 90 days later. If you turn them off while signed in with Google, the row is deleted at once.

If you tick the box in the reminders control to get updates, the address you type there goes to a marketing mailing list for Dr Brad's other business. Typing your email into the box beside your plan also adds you to that list, which the note beside the box names. If your plan has check-ups due, it turns on reminders for that address too. That list is held by Klaviyo. Our emails are sent through Resend. You can unsubscribe from any email.

The feedback box stores your email address and your message, up to 2,000 characters, and emails both to Dr Brad. If you are signed in on this site, it adds your customer number. Nothing deletes that row, so leave health details out of feedback.

## Usage counts, recordings and error reports

The page counts what people use, so we can tell which features to keep. Each event is a fixed name with a few fixed labels, such as which cloud you picked, plus a random visitor id kept in this browser. Free text and the numbers you type are rejected. A few events name a test or measurement, such as one the tool refused to save or the unit you chose for an Lp(a) result, but never its value.

The site uses Microsoft Clarity, which records how visitors move around a page. We mark the tool, the chat and the upload window for Clarity to mask, so their text, including your values, is hidden in those recordings.

Errors are reported to Sentry. Before a report leaves your browser or our server, our code removes request bodies and cookies, known health and identity fields, and numbers that sit next to a unit or a test name. It cannot recognise a diagnosis written in plain words.

Most requests from the tool reach our server through Shopify, which hosts this site. Reminder sign-ups and the Google Drive token exchange go to our server directly. Our server runs on Fly.io in the United States.

## Delete your data

Use the Delete All My Data button at the bottom of your plan. It erases your health record and chat history in this browser and in your connected cloud, and turns off reminders. A few things are out of its reach, including your uploaded files, your provider's version history, the chat text our server keeps for 30 days, your account row if you are signed in, and the chat session and audit rows. [Find your health record file](/blogs/guides/find-your-record#delete-your-data) lists what it leaves in your cloud and says how to remove each one.

To cut the tool off from your cloud, remove the app in your provider's settings: [dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps) for Dropbox, [myaccount.google.com/connections](https://myaccount.google.com/connections) for Google Drive. That also disconnects any AI assistant you connected through us.

## Your rights

This site's [privacy policy](https://drstanfield.com/policies/privacy-policy) names who is responsible for your data and how to ask us to see, correct or delete what we hold. You can write to brad@drstanfield.com.

## If you get stuck

Ask the chat on the tool page. On a phone it is the Chat tab.
