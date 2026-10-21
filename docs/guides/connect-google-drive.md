---
title: "Connect Google Drive to Health by Dr Brad"
description: "Keep your health record in your own Google Drive. Tick the Google Drive box on Google's screen, or the connection is refused. How to retry or disconnect."
slug: "connect-google-drive"
updated: "2026-10-22"
stories: ["US-09"]
---

[The tool](https://drstanfield.com/pages/roadmap) can keep your health record in your own Google Drive. This guide shows how to connect it, and how to fix the one mistake that stops most connections: leaving the Google Drive box unticked on Google's permission screen.

## What connecting does

Everything you save in the tool goes into one file, `health-roadmap.json`. Once Google Drive is connected, that file lives in a folder in My Drive:

```copy-box
Health Plan by Dr Brad/health-roadmap.json
```

It is an ordinary folder you can open at drive.google.com. Our server never holds a copy of your record. Because the file is in your Drive, you can open the tool on another device, sign in with the same Google account, and see the same record.

[Find your health record file](/blogs/guides/find-your-record) lists the other files that can sit in that folder, such as your chat history and the lab reports you upload.

## What access we ask for

The tool asks Google for one Drive permission, `drive.file`. It lets the tool see and change only the files the tool created itself. It cannot see the rest of your Drive: not your documents, not your photos, not a file you upload into the folder by hand.

Google also shares your email address with the tool. The tool says so on the Google Drive option: "Google also shares your email address. We use it only to remind you when a check-up or blood test is due."

## Connect, step by step

1. Open [the tool](https://drstanfield.com/pages/roadmap). Once you have entered something, a button at the top of your plan says "Where do you want to keep your health record?" Click it. The words "Dropbox or Google Drive", in the line that says your record stays in your browser, open the same box.
2. A box opens with the same question as its title. The Google Drive option says "One file in your own Google Drive, in a private "Health Plan by Dr Brad" folder." Its last line says "On Google's screen, tick the Google Drive box. Without it we cannot save your file."
3. Click Google Drive. The page moves to Google.
4. Pick your Google account, and sign in if asked.
5. Google lists what the tool is asking for. The Google Drive permission has a box beside it. **Tick the Google Drive box**, then continue.
6. Google sends you back to the tool. The top of your plan now says "✓ Your health record is yours alone. It lives in your Google Drive".

Google's exact wording on that screen is Google's, and it can change. Look for the line that mentions Google Drive and make sure its box is ticked before you continue. The tool needs only that box to connect.

## If the connection is refused

If the Google Drive box was left unticked, Google still sends you back, but without Drive access. The tool then refuses the connection and keeps nothing from Google. A notice appears above the tool:

> Google didn't grant this app access to Google Drive, so nothing was connected. Try again and tick the Google Drive box on Google's permission screen.

Nothing is lost. Your record stays in this browser, as it was before you started.

To fix it, click Try again on the notice. The same box opens. Click Google Drive again, and this time tick the Google Drive box on Google's screen.

## If you cancel

If you press Cancel on Google's screen, or close it, nothing is connected and no notice appears. You are back where you started, with your record in this browser. Start again from step 1 whenever you like.

If you were switching from Dropbox, the tool copied your record from Dropbox into this browser before it sent you to Google. After a cancel, you are on "This browser only" with that copy. Your file in Dropbox is not touched.

## What happens to a record already in this browser

If you used the tool before connecting, your record is in this browser only. When Google Drive connects, the tool copies everything in this browser into the file in your Drive.

If your Drive already holds a record, from another device, the tool merges the two rather than replacing one with the other.

If that copy cannot reach Drive straight away, the tool keeps your record in this browser and keeps trying. Until it lands, the plan says "Some data in this browser is still waiting to sync to your Google Drive."

## If Google Drive is signed out later

Sometimes the tool cannot sign back in to Google on its own, for example after you withdraw access. The top of your plan then says "Google Drive is signed out", with a Reconnect Google Drive button.

Click it and a Google window opens. The same rule applies: tick the Google Drive box. Anything you changed meanwhile is kept in this browser and merges when you reconnect.

If you would rather stop using Drive, click "Use this browser only" instead. Your file stays in your Drive.

## Disconnect

There are two ways, and they do different things.

Log off this device. Click Google Drive at the top of your plan, then Log off this device. This signs this browser out and clears your record from it. Your file in Drive is not touched. Sign back in with the same account to get everything back. Use this on a shared computer.

Withdraw the tool's access at Google. Go to [myaccount.google.com/connections](https://myaccount.google.com/connections), find the tool in the list, and remove its access. That stops the tool reaching your Drive from any device until you connect again. Your folder and file stay in your Drive. To delete them, delete the folder in Drive yourself.

To erase the record's contents, use Delete All My Data at the bottom of your plan instead. [Find your health record file](/blogs/guides/find-your-record#delete-your-data) explains what it erases and what it cannot reach.

## Other guides

- [Find your health record file](/blogs/guides/find-your-record): where the file is, backups, and moving it to another provider.
- [An open-source health record you can connect to your AI](/blogs/guides/ai-health-record): how the record works and how an AI assistant can read it.
- [Upload a lab report](/blogs/guides/upload-lab-report): add blood test results from a PDF or photo.

## If you get stuck

Ask the chat on the tool page. On a phone it is the Chat tab.
