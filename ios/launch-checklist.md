---
artifact: https://claude.ai/artifact/NbkzYiX7CfGmpFFXJcY2E7
---

# iPhone app: overnight report and launch checklist (2026-10-22 morning)

Everything below is on `main` and pushed. The app runs in the simulator with every
feature. What is left needs your accounts, a real iPhone, a deploy or a decision.
Decisions and their reasons live in [architecture.md](architecture.md); the stories in
US-25 and US-52 of [user-stories.md](../docs/user-stories.md).

## What was built tonight

| Feature | Where | Review |
|---|---|---|
| Device ID kept out of backups, so a restored phone gets a new one | D5 | small, tested |
| Title bars: rows blur under them instead of running under the clock | AC3 | checked in simulator |
| Welcome screen, App Store rating prompt, icon, privacy manifest | AC10 | tested |
| Medications, screenings with PSA, supplements, value history | AC8, AC9 | adversary + Codex |
| Dropbox sync on the website's own sync engine | AC11 | adversary + Codex, 3 rounds |
| On-phone reminders | AC12 | adversary + Codex |
| Apple Health in and out | AC13-AC15 | adversary + Codex |
| Delete all my data, Export my record | AC16 | adversary + Codex |
| Chat tab and "+" lab upload, behind Apple App Attest | US-52 | adversary + Codex |

Shared with the website, so a web fix reaches the app: the plan, every save rule, the
form's questions and hints (moved into health-core `input-form.ts`; the web's
`InputPanel.tsx` now reads them too), sync and merge, erase, reminders, chat history.

Tests: 8,161 pass across the repo; the iOS suite passes in UTC and Auckland time.

Two website changes ride along and ship at the next deploy:
- The web form reads its questions from health-core (rendered page checked identical).
- Saved chats no longer show each answer above its question after a reload (a bug the
  chat work found).

## What only you can do

1. **Apple enrolment** (ID 726UVSY5YZ). When approved: in Xcode set the team, confirm
   the bundle id `com.drbrad.healthroadmap` (a placeholder; changing it means updating
   the Google client too), and add the HealthKit and App Attest capabilities
   (`com.apple.developer.devicecheck.appattest-environment` = production). Replace the
   placeholder release host in `ios/HealthRoadmap/Chat/ServerConfig.swift`.
2. **Dropbox.** In the Dropbox app console (app key `xf96vqvjotm5xhx`), add the redirect
   URI `db-xf96vqvjotm5xhx://2/token`. Dropbox may accept it without this; add it anyway.
   Then, in the simulator, tap Sync, Connect Dropbox, and sign in as
   brad@microvitamin.com. I could not: I may not type passwords into sign-in pages.
   After that, a change on the phone should appear on the website and the other way round.
3. **Google Drive.** In Google Cloud project 687809032623, create an OAuth client of type
   iOS with the bundle id above, then paste its client id into
   `ios/HealthRoadmap/Sync/CloudProvider.swift` (`googleIOSClientId`). Until then the
   button says Drive is not set up.
4. **Server, for chat and lab upload.**
   - Paste the whole of `supabase/rls-policies.sql` into the Supabase SQL editor and run it (it now holds the App Attest table).
   - Set `APP_ATTEST_TEAM_ID` on `health-tool-edu` (until then the routes answer 503).
     Optional: `APP_CHAT_DAILY_CAP`, `APP_LAB_DAILY_CAP` (set from your billing).
   - Never set `APP_ATTEST_DEV_BYPASS` in production (production refuses it anyway).
   - Deploy through CI. `package-lock.json` changed (esbuild), so canary first.
5. **Privacy policy: published** 2026-10-22 at drstanfield.com/pages/app-privacy, from
   [docs/privacy-app-addendum.md](../docs/privacy-app-addendum.md) (audited against the
   code). Read it, and work through its "Items still to verify" list.
6. **App Store Connect:** paste the listing from app-store.md, answer the privacy
   questions (Health data: app functionality, not tracking), add screenshots, archive,
   TestFlight.
7. **Regulatory advice** on whether the app counts as a medical device in your markets
   (architecture.md, Open questions). Still unknown.

## To check on a real iPhone

- Apple Health blood pressure (the simulator's permission sheet leaves it out) and
  background delivery.
- A reminder notification firing, and its tap opening My plan.
- App Attest with a real device key (tested only against a fake certificate authority).
- Deleting the app's Apple Health samples, and the Export share sheet.
- Whether Quick Start (phone to phone) leaves the record behind, as backups do.

## Decisions to confirm (each recorded where it lives)

- **Reminders opt-in is per phone**, not the web's email enrolment (D7). One switch for
  both would need a schema field.
- **Lock screen says only "A check-up is due"**, never which one (D7).
- **Signing in again as a different Dropbox account is refused**; disconnect first (D5).
- **Apple Health rows store the reading's real time with its offset** (D6).
- **No schema bump for the chat order fix** (D10): every reader sorts on read, and a
  bump would have cut off every open web tab's chat history.
- **An unreadable phone record refuses an erase**; deleting the app is the way out (D5).
- **App Store category: Health & Fitness** (app-store.md).

## Known gaps

- Over-the-air engine updates (D3) are not built. The app ships with its engine bundled;
  a clinical fix needs an app update until D3 lands. It is security work: design review
  first.
- No real-Dropbox round trip yet (needs step 2). The sync is tested against a stub that
  follows Dropbox's conflict rules, and the website's code path is the same code.
- An erase made on the website clears this phone's record and reminders, but not its chat
  history, which lives only on the phone.
- The last fix round of sync, erase and Apple Health went past the review cap (one full
  round plus one re-check). I read those diffs myself; no fresh reviewer saw them.
- Lab upload takes one file per request, does not file the document, and skips a day
  that already has a value (no "Replace" yet).
