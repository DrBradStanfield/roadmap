---
artifact: https://claude.ai/artifact/NbkzYiX7CfGmpFFXJcY2E7
---

# iPhone app: launch checklist (updated 2026-10-22)

Everything below is on `main` and pushed. The app runs in the simulator with every
feature. What is left needs your accounts, a real iPhone, a deploy or a decision.
Decisions and their reasons live in [architecture.md](architecture.md); the stories in
US-25 and US-52 of [user-stories.md](../docs/user-stories.md).

## Built

| Feature | Where | Review |
|---|---|---|
| Medications, screenings with PSA, supplements | AC8 | adversary + Codex |
| My data layout: no title bar, "+" and Sync on the About you line, units on Vitals | AC17, D11 | adversary + Codex |
| US height in feet and inches; blood pressure on one line, both halves or neither | AC17 | adversary + Codex |
| Value pages like Apple Health's: chart with scrub, ranges, every value, corrections | AC9, AC17 | adversary + Codex |
| Dropbox sync on the website's own sync engine | AC11 | adversary + Codex |
| "+" asks where the report is: Dropbox, Google Drive, Files, Photos, scan | US-52 AC10-AC12 | adversary + Codex |
| Sync shows the connected account's email (kept on the phone only) | AC11e | adversary + Codex |
| On-phone reminders | AC12 | adversary + Codex |
| Apple Health in and out | AC13-AC15 | adversary + Codex |
| Delete all my data (also the website's chat in the cloud), Export my record | AC16 | adversary + Codex |
| Chat tab and lab upload, behind Apple App Attest | US-52 | adversary + Codex |
| Signed over-the-air engine updates | AC18, D3 | design review, then adversary + Codex |
| Welcome screen, App Store rating prompt, icon, privacy manifest | AC10 | tested |
| App privacy policy, live at drstanfield.com/pages/app-privacy | [addendum](../docs/privacy-app-addendum.md) | adversary + Codex |

Each piece had one full review and one fix-scoped re-check. Fixes after that were read
by the orchestrator, not a fresh reviewer.

## What only you can do

1. **Signing keys for engine updates** ([engine-updates.md](engine-updates.md)).
   - Copy `~/.config/health-roadmap/engine-signing-key-COLD-move-to-1password.txt` into
     the Passwords app, then `rm -P` it.
   - In GitHub, create the environment `engine-signing`, limited to `main`, with you as
     required reviewer. Add the secret `ENGINE_SIGNING_KEY` from
     `~/.config/health-roadmap/engine-signing-key-CI-move-to-github-secret.txt`, then
     `rm -P` it. Paste the workflow from engine-updates.md.
   - The daily key is in this Mac's Keychain. To release from another Mac, move it there
     (engine-updates.md says how).
   - On every release prompt, click **Allow**, never **Always Allow**.
2. **Apple enrolment** (ID 726UVSY5YZ). When approved: in Xcode set the team, confirm
   the bundle id `com.drbrad.healthroadmap` (the Google iOS client uses it), and add the
   HealthKit and App Attest capabilities
   (`com.apple.developer.devicecheck.appattest-environment` = production). Replace the
   placeholder release host in `ios/HealthRoadmap/Chat/ServerConfig.swift`.
3. **Dropbox.** The redirect `db-xf96vqvjotm5xhx://2/token` is added. Sign in once in the
   simulator (Sync, or "+", From Dropbox) as brad@microvitamin.com, so the live sync
   check can run. Agents may not type passwords. Put lab reports in
   Dropbox › Apps › Health Plan by Dr Brad to see them in the list.
4. **Google Drive.** The iOS client exists (2026-10-22). Keep it in the website's project
   (687809032623): `drive.file` shows an app only the files its own project created.
5. **Server, for chat and lab upload.**
   - Paste the whole of `supabase/rls-policies.sql` into the Supabase SQL editor and run
     it (it now holds the App Attest table).
   - Set `APP_ATTEST_TEAM_ID` on `health-tool-edu` once Apple gives you the team id
     (until then the routes answer 503).
   - Never set `APP_ATTEST_DEV_BYPASS` in production.
   - Deploy through CI (it deploys canary-first).
6. **Privacy:** read the live page and its "Items still to verify" list
   (legal review, App Attest row retention).
7. **App Store Connect:** paste the listing and the privacy answers from app-store.md,
   add screenshots, archive, TestFlight.
8. **Regulatory advice** on whether the app counts as a medical device in your markets.
9. **Clinical call:** should the value pages show target bands (blood pressure goal,
   healthy waist, ideal weight)? The targets live only in the website's code today;
   moving them into health-core is a three-file clinical change.

## To check on a real iPhone

The app runs on your iPhone since 2026-10-22, built on the second Mac (Xcode 27.1) with
your free personal team (P7LB54J2PM). Free-team installs expire after 7 days: rebuild
then. App Attest needs the paid team, so chat and upload wait for enrolment.

- Apple Health blood pressure and background delivery.
- A reminder notification firing, and its tap opening My plan.
- App Attest with a real device key.
- Deleting the app's Apple Health samples, and the Export share sheet.
- The document scanner on "+".
- Whether Quick Start (phone to phone) leaves the record behind, as backups do.
- Over-the-air updates on a prewarmed launch: no trial starts, no good release is marked
  bad (D3).
- The Drive email shown in Sync, and that Drive's file download needs no redirect.

## Decisions on record

- Reminders opt-in is per phone (D7); the lock screen says only "A check-up is due".
- Signing in again as a different Dropbox account is refused; disconnect first (D5).
- Replacing a blood pressure corrects only the half that changed; history replays every
  save (D11).
- One cloud connection serves both upload and sync (D8).
- App Store privacy label over-declares: health and user content linked, App Attest key
  and counts not linked.
- An engine update needs your approval (Keychain prompt or GitHub reviewer); a push to
  main alone never reaches phones (D3).

## Known gaps

- No real-Dropbox round trip yet (needs step 3). Sync is tested against a stub that
  follows Dropbox's conflict rules, and the website runs the same code.
- An erase made on the website does not clear chat history kept only on the phone.
- Lab upload takes one file per request and skips a day that already has a value.
