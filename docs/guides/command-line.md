---
title: "Run your health plan from the command line"
description: "Two commands in this repo read your health-roadmap.json and write to it: one prints your plan offline, one files a new value."
slug: "command-line"
updated: "2026-09-02"
stories: ["US-30", "US-31", "US-33"]
---

Your record from the Health by Dr Brad tool is one file, `health-roadmap.json`, in your own cloud storage. This repo carries two commands that work on it directly. `get-plan` reads the file and prints the same plan the web tool would, on your machine, with no network call and no AI model in the loop. `edit-record` files a new value into it, keeping the rules that stop a health record from being quietly rewritten.

This guide is for someone comfortable in a terminal. It also reads as instructions for an AI coding agent working on your behalf: point it here and it can run every command below.

## First, find your file

There is no command that creates a record. The app writes it the first time you save a value with a cloud provider connected, and the tools here only read and change a file that already exists. Point them at a path that does not exist and they refuse, without creating anything.

Where it sits depends on the provider you connected. Dropbox keeps it in an app folder, so on a synced Mac or PC it is at `~/Dropbox/Apps/Health Plan by Dr Brad/health-roadmap.json`. Google Drive keeps it in a folder called `Health Plan by Dr Brad` in My Drive, wherever Drive for desktop mounts My Drive; mark that folder available offline first, or Drive streams the file instead of storing it. GitHub keeps it at the root of the one repo your token is scoped to, so in your clone it is just `health-roadmap.json`. If you never connected a provider, your record is in your browser and there is no file on disk at all: connect one, or export from the app, before you start.

## Or start with the sample

If you only want to see what the commands do, use the fictional record in this repo instead of your own. Copy it first, because the tools write to the file you name:

`cp docs/examples/health-roadmap.sample.json ~/health-roadmap.json`

Every command below uses that copy. Swap in your real path when you are ready.

## Install

You need Node 20.10 or newer. Check with `node --version`. Then:

`git clone https://github.com/DrBradStanfield/roadmap.git`

`npm ci`

Run the commands from the root of the clone.

## See your plan

`npx tsx tools/get-plan.ts ~/health-roadmap.json`

That prints your profile line, your current values with the date each was taken, what is due and when, and the suggestions grouped by priority, each with the reason behind it and the papers it rests on. It is educational, not medical advice, and the output says so.

Two other forms. For an AI agent, or anything that wants to read the plan as data rather than prose:

`npx tsx tools/get-plan.ts ~/health-roadmap.json --json`

For a page you can keep, print, or take to an appointment:

`npx tsx tools/get-plan.ts ~/health-roadmap.json --html ~/plan.html`

The HTML is one self-contained file. It loads nothing from the internet, so it still reads years from now.

The plan needs your height and sex to compute anything. Without them it stops and tells you.

## Add a value

One value per command:

`npx tsx tools/edit-record.ts add ~/health-roadmap.json --metric weight --value 67.8 --date 2026-08-25`

It answers with what it wrote and the id of the new row:

`Added weight 67.8 kg on 2026-08-25 — new row e8ab7e79-a2b3-4d30-903f-1a4f0fc40901`

Core metrics are stored in SI units. Give a value in the other system and add `--unit`, and it converts before storing: `--value 120 --unit mg/dL` on LDL lands as 3.1 mmol/L. Leave `--date` off and it uses today. A future date is refused, and so is a value outside the plausible range for that metric, with the range in the message.

## When the day is already taken

A record holds one value per metric per day. Try to add a second and it refuses rather than choosing for you:

`npx tsx tools/edit-record.ts add ~/health-roadmap.json --metric ldl --value 3.1 --date 2026-05-12`

`edit_record: ldl already has a value on 2026-05-12`

The second line names the row holding that day and gives you the command to fix it, id and all. Every row in `get-plan --json` also carries its `id`.

## Correct a value

`npx tsx tools/edit-record.ts correct ~/health-roadmap.json --id sample-ldl-2026-05-12 --value 3.1`

`Corrected ldl 3.6 → 3.1 mmol/L on 2026-05-12 — new row d22f8b09-dde7-4ff9-8bb5-99713aaf0f37`

Nothing was overwritten. The old row is still in the file, marked as an error and pointing at the new one, and the new row keeps the original date. This is how hospital records work, and it is why you can always see what you were told and when. A correction changes the value and never the date, so `--date` is refused here.

Add `--expect <n>` and the correction only goes through if the row still holds that value; if someone else changed it first, the command refuses instead of correcting the wrong number. Worth adding whenever a script, not a person, is deciding what to correct.

## Add a lab test

Anything outside the core metrics is a lab value, filed under its catalogue name, and it keeps the unit your lab reported rather than being converted:

`npx tsx tools/edit-record.ts add ~/health-roadmap.json --test tsh --value 2.4 --unit mIU/L --date 2026-08-25`

`--unit` is required here. Lab values show in your plan under their own heading; they are informational, and no suggestion is computed from them.

## The backups beside your file

Before every write, the record is copied next to itself as `health-roadmap.json.bak-` plus a timestamp. The newest three are kept and older ones are deleted. If a write files something you did not mean, the copy from just before it is sitting in the same folder.

The write itself goes to a temporary file and is then renamed over the original, so an interrupted run leaves your record whole rather than half rewritten. If the file changed between being read and being written, by another device or by the app in a browser tab, the command notices, reads it again and merges the two edits rather than writing one of them away. Two commands running at the same moment take turns through a `.lock` file beside the record, so the second waits, re-reads and merges instead of overwriting the first — and after every write the command re-reads the file and checks its new rows are really there, so a lost edit is reported rather than confirmed.

## What these commands will not do

They never delete anything. There is no delete command, and no row is ever removed or edited in place. Erasing your data stays something you do in the app.

They never touch your medications, supplements, screenings or profile. Those are current-state fields that a second writer can silently overwrite, so this version leaves them alone.

They never reach the network. No server, no AI model, no analytics. Your record and its backups are the only files touched, and the plan is computed from the numbers in front of it.

## Getting an AI agent to do this for you

Paste this into an AI with access to your terminal.

```bootstrap-prompt
I have cloned https://github.com/DrBradStanfield/roadmap and my health record is a JSON file in my own cloud folder. Read docs/guides/command-line.md in the clone, then work only through the two commands it describes.

Rules:
- Never edit the JSON by hand. Every change goes through npx tsx tools/edit-record.ts, one value per command.
- Ask me where my health-roadmap.json is before you touch anything, and never write to a file I did not name.
- If a command refuses, show me its exact output and stop. Do not work around it, do not retry with different arguments, and do not delete or move the file.
- Before filing values from a lab report, list what you are about to file and wait for me to confirm.
- Read my plan with npx tsx tools/get-plan.ts <file>. Keep each suggestion's wording as written, keep its references with it, and tell me it is educational rather than medical advice.

Start by showing me my current plan.
```

## Connecting your terminal assistant instead

If you use Claude Code or Gemini CLI, they can reach your record through our hosted
server, with no clone and no file path to hand over. Run one of these once:

```bash
claude mcp add --transport http drstanfield https://mcp.drstanfield.com/mcp
gemini mcp add -s user --transport http drstanfield https://mcp.drstanfield.com/mcp
```

A browser opens, you approve the connection and pick your cloud folder, and the
assistant holds the connection from then on. It reads and writes the same file the
commands above do, under the same rules. You cancel it at your cloud provider's
connected-apps page.

## If something goes wrong

Run either command with `--help` for the full list of options. If a command fails in a way this guide does not explain, or the output is wrong, open an issue at https://github.com/DrBradStanfield/roadmap/issues with the command you ran and what it printed. Leave your record out of it; the `schemaVersion` at the top of the file is all we need.
