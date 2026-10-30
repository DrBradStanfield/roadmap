---
title: "Find your health record file"
description: "Where the Health by Dr Brad tool keeps your record in Dropbox, Google Drive, GitHub or your browser, and how to open, back up, move or delete it."
slug: "find-your-record"
updated: "2026-10-22"
stories: ["US-09", "US-10", "US-11", "US-29"]
---

Everything you save in [the tool](https://drstanfield.com/pages/roadmap) goes into one file, `health-roadmap.json`. It holds your profile, your measurements, your blood test results, your medications and your screening answers. It is plain JSON, so any program that reads text can open it.

Where that file lives depends on what you chose when the tool asked where to keep your health record. Our server never stores a copy.

## Which one are you using?

Look at the top of your plan. On a phone, that is the Plan tab. If you connected a cloud, it says "Your health record is yours alone. It lives in your", followed by the name of your provider. Click that name to see the list of places you can keep it, with a tick beside the one you use.

If instead you see a button that says "Where do you want to keep your health record?", nothing is connected. Your record is in this browser only.

## Dropbox

The tool can only reach one folder in your Dropbox. Your record is at:

```copy-box
Apps/Health Plan by Dr Brad/health-roadmap.json
```

If you connected before the app was renamed, Dropbox kept your original folder name, so look in `Apps/Health Roadmap by Dr Brad` instead.

To open it, go to dropbox.com, open Apps, then the folder, and download the file like any other. If the Dropbox app is on your computer, the file is also on your disk at `~/Dropbox/Apps/Health Plan by Dr Brad/health-roadmap.json`.

## Google Drive

Your record is in a folder in My Drive:

```copy-box
Health Plan by Dr Brad/health-roadmap.json
```

It is an ordinary folder you can see, not a hidden app folder. Go to drive.google.com, open My Drive, then Health Plan by Dr Brad, and download the file from there.

The tool can see only the files it created itself. It cannot see the rest of your Drive. That also means a copy of the record you upload by hand is invisible to the tool, so leave the file where the tool put it and keep its name.

## GitHub

Your record sits at the top level of the private repository you connected, on its default branch, as `health-roadmap.json`. The tool refuses a public repository. Open the repository on github.com to view or download the file, or clone it. Every save is a commit, so the repository's history holds every earlier version.

## Your own server

If you connected a WebDAV server, such as Nextcloud, the file is `health-roadmap.json` in the folder whose address you gave the tool.

## This browser only

With nothing connected, there is no file to find. The tool keeps your record in this browser's own storage, for this site. Another browser, or another device, does not see it.

Clearing your browsing data for the site deletes it, and so can a private window when it closes.

To get your record out, connect Dropbox or Google Drive. Click "Where do you want to keep your health record?" and pick one. The tool copies everything in this browser into the new file, merging it with anything already there. From then on you have a real file you can open.

## Other files in the same folder

You may see more than the record.

- `chat-history.json` holds your conversations with the tool's chat. It is a separate file.
- Lab reports and letters you uploaded sit in folders beside the record: Lab results, Scans, Clinic letters and Other documents. Each file name starts with the date, so they list in order. On Google Drive these are folders inside Health Plan by Dr Brad.
- If an AI connector imported lab files for you, a pending import file can sit in the folder until you confirm or the import expires.

How uploads work is in [upload a lab report](/blogs/guides/upload-lab-report).

## Backups

The website keeps no separate backup file. It writes your record straight to your provider. The safety net is your provider's own version history, which Dropbox, Google Drive and GitHub all keep. To go back to an earlier copy, restore it there.

The command-line tool, and Claude running on your own computer, make a backup each time they write. It sits beside the record with a time in its name, like `health-roadmap.json.bak-2026-10-21T08-30-00.000Z`. The last three are kept. Those are the only backup files we make.

## Move it somewhere else

To switch provider, click your provider's name at the top of your plan, or the "Where do you want to keep your health record?" button, and pick another. The tool first copies your record from the old provider into this browser, then into the new one. If the old provider cannot be reached, the switch stops, so your record is never left behind.

The old file stays where it was. The tool does not delete it. Your uploaded lab reports do not move either, so copy them across yourself if you want them in the new place.

To take your record to another tool, download the file. The format is published as a [JSON Schema](https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/docs/health-roadmap-file.schema.json). An AI on your own computer can read it directly: see [the command line](/blogs/guides/command-line) or [connect Claude](/blogs/guides/connect-claude). Before an AI writes to it, read the rules in [the open-source health record guide](/blogs/guides/ai-health-record).

## Log off a device

To stop using the tool on a shared computer, click your provider's name at the top of your plan, then Log off this device. That signs this browser out and clears your record from it. The file in your cloud is not touched. Sign back in with the same account to get everything back.

## Delete your data

Use the Delete All My Data button at the bottom of your plan. The tool explains what it will erase before you confirm.

It erases your health record and chat history in this browser and in your connected cloud. The file itself stays, now empty except for a note of the erase. That note is what makes your other devices and open tabs drop the same values when they next read the file. A value another device had not saved yet is kept and arrives later.

Some things it cannot reach, and the confirm box lists them:

- the lab reports and letters you uploaded to your cloud folder
- any pending import file from an AI connector
- your provider's version history, and every past commit on GitHub
- backups from the command-line tool, until that tool next writes the file
- your chat questions on our server: on the tool page each is blanked 30 days after you sent it; on the chat bubble and the chatbot embed, questions, replies and the title are gone 30 days after your last message in that chat

Delete those in your cloud account if you want them gone.

Do not delete the file by hand to erase your record. A tab or device that still has your record open can save it again, and the file comes back.

If you only want to fix a wrong number, you do not need to delete anything: [how to fix a value](/blogs/guides/upload-lab-report#fix-a-value-after-saving).

## If you get stuck

Ask the chat on the tool page. On a phone it is the Chat tab.
