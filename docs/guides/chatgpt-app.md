---
title: "Health by Dr Brad in ChatGPT"
description: "What the Health by Dr Brad app does inside ChatGPT, what each of its nine tools can do to your health record, and what it never does."
slug: "chatgpt-app"
updated: "2026-09-18"
stories: ["US-32", "US-36"]
---

Your health record is one file, `health-roadmap.json`, in your own Dropbox or Google Drive. It is yours. We do not hold a copy, and we have no database of your results.

The Health by Dr Brad app is the bridge between that file and ChatGPT. You authorize it once, against your own cloud account, and ChatGPT can then read your results, work out your plan, add new values and correct an old one. Setting it up takes about five minutes: the steps are in [connecting ChatGPT to your health record](/blogs/guides/connect-chatgpt).

This page is the plain description of what the app can do. It is for anyone deciding whether to connect it, and for anyone reviewing it.

## How your data moves

You connect Dropbox or Google Drive yourself, through that provider's own permission screen, and you can withdraw it there at any time: [dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps) or [myaccount.google.com/connections](https://myaccount.google.com/connections).

To answer one request, our server fetches your file using your own credential, holds it in memory for that request, and writes it back if you asked for a change. Nothing is kept afterwards. There is no per-user row on our side, no health table, and no copy at rest. Your values never enter our logs, our error reports or our analytics.

One exception, and it is yours to trigger: if you ask the app to import the lab files in your connected Dropbox folder, those files go to Anthropic's API so the text can be read. Your record itself is never sent. We keep none of the files afterwards.

## What it can do

Nine tools. Each one says what it does and what it will not do.

### `read_record`: Read the health record

Reads your file and returns what it holds: your profile, your measurements, your lab results, your medications and supplements, the screenings you have recorded, and the documents you have filed.

**What it will not do.** It writes nothing, and it never returns your reminder token.

### `get_plan`: Compute the health plan

Works out the same plan the website shows: your current values, what screening is due at your age, and suggestions with the reason and the citation behind each one.

**What it will not do.** It changes nothing, and it is educational information, not medical advice.

### `add_measurement`: Add a core measurement

Adds one value you state, such as a weight or a blood pressure, on the day you say it was taken.

**What it will not do.** It never overwrites. A second value for the same thing on the same day is refused, and you are sent to a correction instead.

### `add_lab_values`: Add lab results

Adds a whole blood panel in one go, up to 50 tests, each with the unit the lab printed and the date it was taken.

**What it will not do.** It never replaces a result you already hold, and it files all the rows or none of them.

### `correct_value`: Correct a recorded value

Fixes a number that went in wrong. The new value is added at the original date and the old row is marked entered-in-error.

**What it will not do.** It deletes nothing, it cannot be undone, and it refuses unless the value it is told to expect is the value it finds.

### `update_profile`: Change the profile the plan is computed from

Changes the four things your plan is worked out from: your sex, your birth year, your birth month and your height.

**What it will not do.** It touches no result. Changing a field you already hold requires the value it expects to find, so a wrong guess writes nothing.

### `report_feedback`: File a bug report or feature request

Reports a problem for you, as a public issue on the project, when something refuses or looks wrong.

**What it will not do.** It opens no health record. It refuses anything that reads as a health value, an email address, a phone number, a file name or a link carrying a token, and it shows you the report before you say yes; the report carries only what the assistant wrote about the problem.

### `import_documents`: Import lab files from the Dropbox folder

Reads the lab files sitting in your own connected Dropbox folder and shows you every value it found against what your record already holds.

**What it will not do.** It changes nothing in your record until you say yes; the values it found wait in a small file in your own folder until then. It works on Dropbox only: on Google Drive the permission we ask for cannot list a folder, and it says so.

### `file_results`: File the results you read from a document

Files the results from a report you drop into the chat. ChatGPT reads the file itself and sends us only the values it read, checked against our own catalogue, units and ranges.

**What it will not do.** The file never reaches our server, and the document is filed by name and date only, never its contents.

There is no delete. Nothing in your record can be removed by any tool here. A correction adds the right value and marks the wrong one entered-in-error, so the history stays honest and you can see what was changed.

## Before anything permanent

Three tools change something that cannot be reversed: correcting a value, changing your profile, and filing a bug report. Each takes two calls. The first writes nothing and hands back a receipt saying exactly what would happen. Only after you say yes, in your own words, does the second one act. Filing results from a document works the same way: a receipt first, the write after your yes.

ChatGPT has a setting that skips its own approval prompt for a connector. That setting is not your yes, and our tools say so: they still ask, and they still wait.

Two more things worth knowing. Your record holds one value per test per day, so adding a second one is refused rather than allowed to bury the first. And a correction has to name the value it expects to find, so a stale reading cannot silently fix the wrong row.

## Shortcuts

Ready-made prompts appear in ChatGPT's own menu once the app is connected. Picking one sends the words below, and nothing else.

**Summarise my plan**

```
Call get_plan, then summarise my plan in plain words — keep its hedged wording and citations — and tell me which inputs it lists as missing.
```

**Add today’s results**

```
I have blood test results to add. Ask me for the date they were taken and each test with its value and unit, then read my record and add them.
```

**What is missing?**

```
Call get_plan and tell me which inputs my record is missing that would change the plan, and how I could get each one.
```

**Import my lab files**

```
If I have dropped a lab file into this chat, read it and call file_results with every value it prints; otherwise call import_documents to read the lab files in my connected Dropbox folder. Show me every value found against what my record already holds, and file only what I confirm.
```

## What it never does

It never deletes a value. It never reads another person's record. It never stores your data on our servers. It never sends your record to a model of ours. A bug report refuses anything that reads as a health value, an email address, a phone number, a file name or a link carrying a token. It never sells anything: there is nothing to buy through the app.

It also cannot do things it is sometimes asked for. It writes no meal plans. It books no appointments. It does not message a doctor. For a general medical question that has nothing to do with your own record, ChatGPT answers on its own and no tool runs.

## Not medical advice

The plan is educational information, worked out from published guidelines and the evidence behind each suggestion, with the citation attached. Its hedged wording is deliberate. It does not replace your doctor, and it is not a diagnosis.

If something looks wrong, ask the app to report it. The issue it files is public, so it shows you the report first and sends only what the assistant wrote about the problem.
