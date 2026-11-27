---
title: "Connect Google Drive to Health by Dr Brad"
description: "Keep your health record in your own Google Drive. Tick the Google Drive box on Google's screen or the connection is refused. Retry or disconnect."
slug: "connect-google-drive"
updated: "2026-11-09"
stories: ["US-09"]
---

[The website](https://drstanfield.com/pages/roadmap) can keep your health record in your own Google Drive. This guide shows how to connect it, and how to fix the one mistake that stops most connections: leaving the Google Drive box unticked on Google's permission screen.

## What connecting does

Everything you save in the tool goes into one file, `health-roadmap.json`. Once Google Drive is connected, that file lives in a folder in My Drive:

```copy-box
Health Plan by Dr Brad/health-roadmap.json
```

It is an ordinary folder you can open at drive.google.com. Our server never stores a copy of your record. Because the file is in your Drive, you can open the website on another device, sign in with the same Google account, and see the same record.

[Find your health record](/blogs/guides/find-your-record) lists the other files that can sit in that folder, such as your chat history and the lab reports you upload.

## What access we ask for

The website asks Google for one Drive permission, `drive.file`. It lets the website see and change only the files it created itself. It cannot see the rest of your Drive: not your documents, not your photos, not a file you upload into the folder by hand.

Google also shares your email address with the website. The website says so on the Google Drive option: "Google also shares your email address. We use it only to remind you when a check-up or blood test is due."

## Connect, step by step

1. Open [the website](https://drstanfield.com/pages/roadmap). On a phone, open the Account tab: a button that says "Keep my record in Dropbox or Google Drive" heads it. On a computer, the same button appears at the foot of My health once you have entered your height, and in Settings (the person button beside the My health title); the Sign in button beside that title opens the same box. Click the button. The words "Dropbox or Google Drive", in the line under the button, open the same box too.
2. A box opens, titled "Where do you want to keep your health record?" The Google Drive option says "One file in your own Google Drive, in a private "Health Plan by Dr Brad" folder." Its last line says "On Google's screen, tick the Google Drive box. Without it we cannot save your file."
3. Click Google Drive. The page moves to Google.
4. Pick your Google account, and sign in if asked.
5. Google lists what the website is asking for. The Google Drive permission has a box beside it. **Tick the Google Drive box**, then continue.
6. Google sends you back to the website. Beside the My health title on a computer, or the Account title on a phone, it now says "Synced to Google Drive". Settings on a computer, and the Account tab on a phone, say "✓ Your health record is yours alone. It lives in your Google Drive".

Google's exact wording on that screen is Google's, and it can change. Look for the line that mentions Google Drive and make sure its box is ticked before you continue. The website needs only that box to connect.

## If the connection is refused

If the Google Drive box was left unticked, Google still sends you back, but without Drive access. The website then refuses the connection and keeps nothing from Google. A notice appears below the page heading:

> Google didn't grant this app access to Google Drive, so nothing was connected. Try again and tick the Google Drive box on Google's permission screen.

Nothing is lost. Your record stays in this browser. If you were switching from Dropbox, the website signed this browser out of Dropbox before it sent you to Google, so you are now on "This browser only" with a copy of your record. Your record in Dropbox is not touched.

To fix it, click Try again on the notice. The same box opens. Click Google Drive again, and this time tick the Google Drive box on Google's screen.

## If you cancel

If you press Cancel on Google's screen, nothing is connected and no notice appears. You are back where you started, with your record in this browser. Start again from step 1 whenever you like.

If you were switching from Dropbox, the website copied your record from Dropbox into this browser before it sent you to Google. After a cancel, you are on "This browser only" with that copy. Your record in Dropbox is not touched.

## What happens to a record already in this browser

If you used the website before connecting, your record is in this browser only. When Google Drive connects, the website copies everything in this browser into the file in your Drive.

If your Drive already holds a record, from another device, the website merges the two rather than replacing one with the other.

If that copy cannot reach Drive straight away, the website keeps your record in this browser and keeps trying. Until it lands, the plan says "Some data in this browser is still waiting to sync to your Google Drive."

## If Google Drive is signed out later

Sometimes the website cannot sign back in to Google on its own, for example after you withdraw access. A "Sign in to Google again" button then shows beside the My health title on a computer, and at the top of My health on a phone. Settings on a computer, and the Account tab on a phone, say "Google Drive is signed out", with a Reconnect Google Drive button.

Click it and a Google window opens. The same rule applies: tick the Google Drive box. Anything you changed meanwhile is kept in this browser and merges when you reconnect.

If you would rather stop using Drive, click "Use this browser only" instead. Your record stays in your Drive.

## Disconnect

There are two ways, and they do different things.

Log off this device. Open Settings on a computer, or the Account tab on a phone. Click Google Drive in the line that says where your record lives, then Log off this device. The website asks "Log off this device?". Click Log off. This signs this browser out and clears your record from it. Your record in Drive is not touched. Sign back in with the same account to get everything back. Use this on a shared computer.

Withdraw the tool's access at Google. Go to [myaccount.google.com/connections](https://myaccount.google.com/connections), find the tool in the list, and remove its access. That stops the tool reaching your Drive from any device until you connect again. It also cuts off the ChatGPT or Claude connector, if you use one, because the connector signs in to Google as the same app. Your folder and file stay in your Drive.

To delete your record, first use Delete all my data, at the bottom of Settings on a computer or of the Account tab on a phone. [Find your health record](/blogs/guides/find-your-record#delete-your-data) explains what it deletes and what it cannot reach. Do not delete the folder by hand to delete your record. A tab or device that still has your record open can save it again, and the file comes back. Once Delete all my data has run, you can delete the folder too if you want.

## Other guides

- [Find your health record](/blogs/guides/find-your-record): where the file is, backups, and moving it to another provider.
- [An open-source health record you can connect to your AI](/blogs/guides/ai-health-record): how the record works and how an AI assistant can read it.
- [Upload a lab report](/blogs/guides/upload-lab-report): add blood test results from a PDF or photo.

## If you get stuck

Ask Chat on the website. On a phone it is the Chat tab.
