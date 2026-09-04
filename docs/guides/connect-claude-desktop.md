---
title: "Connect Claude to your health record"
description: "Point Claude Desktop or Claude Code at your health-roadmap.json and it can read your results, compute your plan, and file new ones."
slug: "connect-claude"
updated: "2026-09-02"
stories: ["US-32"]
---

Your record from the Health by Dr Brad tool is one file: `health-roadmap.json`, in your own Dropbox, Google Drive or GitHub folder. This repo ships a small program that hands that file to Claude as a set of named tools. Once it is connected you can say "add my new blood panel" or "what does my plan say about my LDL" and Claude does it, in your file, on your machine.

This guide is for people who have the tool installed on a computer and are comfortable pasting a line into a terminal or editing one settings file. It takes about five minutes.

## What Claude gets

A short, fixed list of tools, and nothing else:

Read your record. Everything in the file: profile, measurements, blood tests, medications, supplements, screenings, documents. Claude can ask for one test or one date range instead of the lot.

Compute your plan. The same plan the web tool shows, worked out offline from your file, with the reason and the citations behind every suggestion.

Add a measurement. One core value, such as a weight or an LDL.

Add lab results. A whole panel in one call, up to 50 tests, in the lab's own numbers and units.

Correct a value. Fix a number that went in wrong.

Change four things about you. Your sex, your birth year, your birth month and your height, because your plan is worked out from those. Nothing else about you is writable.

Report a problem. If a tool refuses something you reasonably expected, ask Claude to report it. The program on your computer holds no key to anything, so it cannot file anything itself: it hands you a prefilled link to a public issue on the project's GitHub, carrying its description of the problem and nothing about you. Nothing is filed until you open that link and press the button. (The hosted connectors, Claude on the web and ChatGPT, do file it themselves. Their guides say so.)

Import lab files. This one is hosted-only, over Dropbox: the local program you run here has no model and no network, so it lists the tool and refuses it, pointing you at the website's upload or the hosted connector instead.

The file stays where it is. Nothing is uploaded, no account is created, no key is needed. The program opens no network connection at all: it reads your file, changes it, and writes it back.

One thing is held back on purpose. If you use email reminders, your record carries a token that manages that schedule on our server. It is stripped out of every read, so it can never end up in a chat transcript.

## Before you start

You need three things.

Node.js 20.10 or newer, from [nodejs.org](https://nodejs.org). Check with `node --version`.

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

There is no delete tool. Nothing Claude can call removes a row. It also cannot touch your medications, supplements, screenings or documents: those are current state that a second device could overwrite, so for now only clinical values are writable this way.

It can change four things about you: your sex, your birth year, your birth month and your height, because your plan is worked out from those. Unlike a blood test, they are not kept in history: the newest write is the one your record keeps, so the later of two changes made in the same minute is what you end up with. Claude states what it believes the field holds before it changes one, and is refused if it has that wrong. How the site displays units is not Claude's to change.

Every write copies your record to a backup beside it first, named `health-roadmap.json.bak-` and the time. The last three are kept. If a write goes wrong, that file is your record from the moment before it.

Two more habits worth keeping. The local writer takes a lock file and merges its edit in if it hits a conflict. A browser tab writing through your cloud provider's own API sits outside that lock. Do not have both open at once. And check what it files, because an AI can misread a lab report the same way a person can.

## Claude on the web

Claude in a browser cannot open a file on your computer, and nothing in the sections above changes that. What it can do is connect to a small server we run, which opens your Dropbox or Google Drive folder for the length of one call. Same tools, same rules, no software on your machine.

This works with Dropbox and Google Drive today. On Drive, Google offers no conditional write, so our server checks the file version before and after each save; two writers landing at the same instant can still race.

1. In claude.ai, open Settings, then Connectors, then Add custom connector. Or follow [this link](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Health%20Roadmap&connectorUrl=https%3A%2F%2Fmcp.drstanfield.com%2Fmcp), which opens that dialog with the name and the address already in it and waits for you to confirm.

2. Name it Health by Dr Brad, with this address:

```copy-box
https://mcp.drstanfield.com/mcp
```

3. Press Add, then Connect. Our own page opens and says what the connector does. Press Continue to Dropbox and approve it there.

4. In a chat, open the + menu, switch Health by Dr Brad on, and say "read my record".

The hosted version is append-only, like this one, with two extra limits: a correction on a row older than 90 days is refused, and Claude has to state the value it believes it is replacing, so a correction written from a stale read changes nothing.

It can also import lab files, but only from a connected Dropbox: ask it to import the lab files in your Dropbox folder and it reads the PDFs and images sitting there, showing you candidates before anything is saved. Claude has no way to take a file you drag into the conversation, so on a Google Drive connection there is no import route at all — use the website's own upload instead. The file you import goes through our server to Anthropic's API for extraction and is kept nowhere, a different path from the website's upload, which reads the PDF in your browser and sends only the extracted text to our server.

You cancel it at [dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps). That also disconnects this website from the folder, and reconnecting in the tool is one click. The [Connector Privacy Notice](https://drstanfield.com/pages/connector-privacy) explains what the connector stores, which is nothing, and how to disconnect.

ChatGPT connects the same way, with one extra step: [connect ChatGPT to your health record](/blogs/guides/connect-chatgpt).

## If something goes wrong

Claude Desktop shows no tools: check the paths in the config file are absolute, restart the app fully, and confirm `npx tsx --version` runs in a terminal.

Claude says it cannot find the record: run `ls` on the path you configured. A Dropbox or Drive file set to online-only is not on disk, whatever the folder shows.

Anything else, or something that looks wrong in your data: open an issue at [github.com/DrBradStanfield/roadmap/issues](https://github.com/DrBradStanfield/roadmap/issues), or open the chat bubble on any page of this site and ask.
