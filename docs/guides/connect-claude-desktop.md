---
title: "Connect Claude to your health record"
description: "Point Claude Desktop or Claude Code at your health-roadmap.json and it can read your results, compute your plan, and file new ones."
slug: "connect-claude"
updated: "2026-09-02"
stories: ["US-32"]
---

Your record from the Health Roadmap tool is one file: `health-roadmap.json`, in your own Dropbox, Google Drive or GitHub folder. This repo ships a small program that hands that file to Claude as a set of named tools. Once it is connected you can say "add my new blood panel" or "what does my plan say about my LDL" and Claude does it, in your file, on your machine.

This guide is for people who have the tool installed on a computer and are comfortable pasting a line into a terminal or editing one settings file. It takes about five minutes.

## What Claude gets

A short, fixed list of tools, and nothing else:

Read your record. Everything in the file: profile, measurements, blood tests, medications, supplements, screenings, documents. Claude can ask for one test or one date range instead of the lot.

Compute your plan. The same plan the web tool shows, worked out offline from your file, with the reason and the citations behind every suggestion.

Add a measurement. One core value, such as a weight or an LDL.

Add lab results. A whole panel in one call, up to 50 tests, in the lab's own numbers and units.

Correct a value. Fix a number that went in wrong.

Report a problem. If a tool refuses something you reasonably expected, Claude can draft a bug report and hand you a GitHub link to review. Nothing is filed without you.

The file stays where it is. Nothing is uploaded, no account is created, no key is needed. The program opens no network connection at all: it reads your file, changes it, and writes it back.

One thing is held back on purpose. If you use email reminders, your record carries a token that manages that schedule on our server. It is stripped out of every read, so it can never end up in a chat transcript.

## Before you start

You need three things.

Node.js 20 or newer, from [nodejs.org](https://nodejs.org). Check with `node --version`.

This repo on your computer: `git clone https://github.com/DrBradStanfield/roadmap.git`. Then `cd roadmap && npm install`.

The path to your record. Your cloud folder has to be synced to disk, so the file is really there. Dropbox puts it at `~/Dropbox/Apps/Health Plan by Dr Brad/health-roadmap.json`. Google Drive for desktop mounts My Drive somewhere like `~/Library/CloudStorage/GoogleDrive-you@example.com/My Drive/Health Plan by Dr Brad/health-roadmap.json` on a Mac, and the folder has to be set "Available offline" or Drive streams the file instead of storing it. If you have never connected a cloud provider there is no file on disk at all, because the tool is holding your record in your browser. Connect a provider first, or export the file from the app.

## Claude Code

One line, run once, from anywhere:

`claude mcp add health-roadmap -s user -- npx tsx /path/to/roadmap/tools/mcp-server.ts --file /path/to/health-roadmap.json`

Swap in your own two paths. `-s user` makes it available in every folder you work in; drop it and the connection belongs to the current folder only.

Check it took with `claude mcp list`. You want to see `health-roadmap` and a tick. To undo it, `claude mcp remove health-roadmap`.

## Claude Desktop

Open the settings file. On a Mac it is `~/Library/Application Support/Claude/claude_desktop_config.json`. On Windows it is `%APPDATA%\Claude\claude_desktop_config.json`. If it does not exist yet, create it.

Paste this in, with your own two paths in place of the ones shown, and restart Claude Desktop.

```bootstrap-prompt
{
  "mcpServers": {
    "health-roadmap": {
      "command": "npx",
      "args": [
        "tsx",
        "/path/to/roadmap/tools/mcp-server.ts",
        "--file",
        "/path/to/health-roadmap.json"
      ]
    }
  }
}
```

If the file already has an `mcpServers` block, add the `health-roadmap` entry inside it rather than pasting a second block.

## Say this first

"Read my record."

Claude comes back with what is in the file, and from there you can ask it anything: what your LDL has done over four tests, what the plan says to do about it, what screening you are due. Then try "add today's weight, 81.5 kg", or paste in a lab report and ask Claude to file it.

## What it will refuse

Your record holds one value per test per day. Ask Claude to add a second weight for a day that already has one and the call is refused, by name:

"weight already has a value on 2026-09-01. That day already holds 80.6 in row 5193822b. Nothing was written. To change it, call correct_value with that row id."

That is the design, not a fault. Two weights for one day and nothing downstream knows which one is you.

A correction is its own step, and it never erases anything. Claude adds a new row with the corrected number and the original date, and marks the old row "entered-in-error". Both rows stay in the file for good. That is how a hospital record works, and it is why you can always see what you were told and when.

There is no delete tool. Nothing Claude can call removes a row. It also cannot touch your medications, supplements, screenings, documents or profile: those are current state that a second device could overwrite, so for now only clinical values are writable this way.

Every write copies your record to a backup beside it first, named `health-roadmap.json.bak-` and the time. The last three are kept. If a write goes wrong, that file is your record from the moment before it.

Two more habits worth keeping. Do not leave the web tool open in another tab while Claude is writing the file; there is no lock, and one writer will lose. And check what it files, because an AI can misread a lab report the same way a person can.

Dates come from the clock in UTC, not your local timezone. If you are well ahead of UTC, "today" can land on yesterday's date. Say the date you mean and Claude will pass it through.

## Claude on the web cannot do this

The Claude app in your browser, and ChatGPT in your browser, cannot reach a file on your computer. Nothing in this guide will change that. What is described here runs on your machine, between a program on your disk and an app on your disk.

We are building a hosted connector so a web user can grant access to their cloud folder and take it back whenever they want. It is designed and not built. When it ships it will do the same things this does. Until then, this is the honest answer: a desktop app or a terminal, or nothing.

## If something goes wrong

Claude Desktop shows no tools: check the paths in the config file are absolute, restart the app fully, and confirm `npx tsx --version` runs in a terminal.

Claude says it cannot find the record: run `ls` on the path you configured. A Dropbox or Drive file set to online-only is not on disk, whatever the folder shows.

Anything else, or something that looks wrong in your data: open an issue at [github.com/DrBradStanfield/roadmap/issues](https://github.com/DrBradStanfield/roadmap/issues), or open the chat bubble on any page of this site and ask.
