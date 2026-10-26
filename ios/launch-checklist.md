---
artifact: https://claude.ai/artifact/NbkzYiX7CfGmpFFXJcY2E7
---

# iPhone app: launch checklist (updated 2026-10-27)

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
| Onboarding: Apple Health, then sex, birth month and year, height, weight, one per screen; "I already use Health Roadmap" (2026-10-22) | US-54, D12 | adversary + Codex, /simplify |
| Clarity analytics, every screen masked, off until its project id is set (2026-10-22) | US-25 AC19, D9 | adversary + Codex, /simplify |
| Speed and tidying: plan only while on screen, cached value history, one date format (2026-10-22) | AC6, AC9 | adversary + Codex, /simplify |
| UI tests (onboarding, large text, the Health sheet, plan refresh) and App Store screenshots (2026-10-22) | US-54, AC10 | adversary + Codex, /simplify |
| "Delete all my data" (here or on another device) brings the onboarding questions back; My data no longer slows with years of blood pressure (17 s to 0.1 s at ten years, on an iPhone 15 Pro Max) | US-54 AC7 | adversary + Codex, /simplify |

Each piece had one full review and one fix-scoped re-check. Fixes after that were read
by the orchestrator, not a fresh reviewer.

## What only you can do

1. **Signing keys for engine updates** ([engine-updates.md](engine-updates.md)).
   - Done 2026-10-25: the workflow `.github/workflows/engine-release.yml` (added with
     your permission) and the GitHub environment `engine-signing`, limited to `main`,
     with you as required reviewer. Secret `ENGINE_SIGNING_KEY` set 2026-10-26.
   - Done 2026-10-26: all three private keys are in your Passwords app (the key
     files were deleted on 2026-10-22). You ran
     `gh secret set ENGINE_SIGNING_KEY --env engine-signing`, with the ci line from
     Passwords; `gh secret list --env engine-signing` lists it. The real
     test is the first Engine release after a Deploy on main: if none starts on its own,
     run Actions › Engine release › Run workflow on main.
   - The daily key is in the iMac's login Keychain and in Passwords as "Health Roadmap engine
     signing key (daily)" (and the new Mac's Keychain, if you added it). To
     release from another Mac, move it there
     (engine-updates.md says how).
   - On every release prompt, click **Allow**, never **Always Allow**.
2. **Apple enrolment: done 2026-10-25.** Team Dr Brad, Inc (KAV75KMV2R), account
   brad@drstanfield.com, signed in to Xcode. Bundle id `com.drstanfield.healthroadmap`,
   registered with HealthKit and App Attest (the free team holds the old
   `com.drbrad.healthroadmap`, which Apple will not release). Brad's iPhone 15 Pro Max is a
   registered device. Release host stays `health-tool-edu.fly.dev` (Brad's call). The
   Google iOS client was made for the old id: if Drive sign-in fails, change its bundle id
   in Google Cloud (Brad approved).
3. **Dropbox.** The redirect `db-xf96vqvjotm5xhx://2/token` is added. Sign in once in the
   simulator (Sync) as brad@microvitamin.com, so the live sync check can run. Agents
   may not type passwords. To read a lab report from Dropbox, "+" then Files: with the
   Dropbox app installed, any Dropbox folder is reachable (2026-10-25, US-52 AC10).
4. **Google Drive.** The iOS client exists (2026-10-22). Keep it in the website's project
   (687809032623): `drive.file` shows an app only the files its own project created.
5. **Server, for chat and lab upload: done 2026-10-25.** Brad ran
   `supabase/rls-policies.sql` (the App Attest table and `app_attest_use` exist).
   `APP_ATTEST_TEAM_ID=KAV75KMV2R` and `APP_ATTEST_BUNDLE_ID=com.drstanfield.healthroadmap`
   are set on `health-tool-edu`. Proven on Brad's iPhone: attest/register 200, chat 200.
   Never set `APP_ATTEST_DEV_BYPASS` in production.
6. **Privacy:** published again 2026-10-26 with the five Apple Health readings. Read the
   live page and its "Items still to verify" list (legal review, App Attest row retention).
7. **App Store Connect (2026-10-27): build 3 submitted, Waiting for Review.** App record
   6826824214: listing, review notes (one-step Apple Health), contact, version 0.1, automatic
   release, free in 175 countries, age 16+, App Privacy published, five 6.3-inch screenshots,
   declared **not a regulated medical device**, EU trader status declared by Brad.
   - Build 3 (2ce7c138: VO2 legend fix, Apple's Low line from 60, DPP 2002 citation) was
     archived, uploaded from the Organizer by the session, attached to 0.1 and submitted
     2026-10-27 09:27. Apple says up to 48 hours; release is automatic on approval.
   - Build 2 was uploaded but never submitted (VO2 legend slip).
   - The five screenshots predate build 3 but show none of its changes, so they stand.
   - **TestFlight:** build 3 is in beta review with one external tester (Brad's request). The
     invite goes out on approval. Test Information holds the beta description and contact.
   - **Next build:** an agent shell cannot upload (no App Store Connect token); the session
     clicks Organizer › Distribute App while the Mac is unlocked (full-screen control).
   - **Build 3 is on Brad's iPhone** (Release, 2026-10-27).
   - **Build 4 (next):** the Apple Health cards keep their last readings on the phone, so My
     data opens without the launch jump (US-56 AC2 and AC15, Brad 2026-10-27, checked on his
     iPhone). Brad approved the new privacy wording (2026-10-27): publish the privacy page
     (`node scripts/build-privacy-page.mjs app --publish`) **when build 4 is submitted, not
     before**: the live page's "never saves them" stays true for build 3. Update the App Store
     description and review notes from ios/app-store.md in the same submission.
8. **Regulatory advice** on whether the app counts as a medical device in your markets.
9. **Clinical call:** should the value pages show target bands (blood pressure goal,
   healthy waist, ideal weight)? The targets live only in the website's code today;
   moving them into health-core is a three-file clinical change.
10. **Clarity** (D9). Done 2026-10-22: mobile project `z1kbjvj8u6`, Strict masking, no
    consent prompt (Brad's call; the risk is in D9). Before release, watch one real
    recording to confirm every screen is masked (the supplement search bar included).
    Decide whether to pause Clarity on two-button questions (tap position can show the answer).
11. **App Store pictures** are in `ios/build/app-store-shots/` (run
    `ios/scripts/app-store-shots.sh "iPhone 18 Pro"` again after any UI change).

## To check on a real iPhone

The app runs on your iPhone since 2026-10-22, built on the second Mac (Xcode 27.1) with
your free personal team (P7LB54J2PM). Free-team installs expire after 7 days: rebuild
then. App Attest needs the paid team, so chat and upload wait for enrolment.

- **Onboarding** (installed 2026-10-22; it starts when you open the app, since your
  record is empty): Allow on Apple's sheet, then sex and birth month and year
  preselected from Health and labelled "From Apple Health"; a changed weight on a day
  that has one asks "Replace it?". The UI tests cannot answer Apple's sheet.
- Apple Health blood pressure and background delivery.
- A reminder notification firing, and its tap opening My plan.
- App Attest with a real device key.
- Deleting the app's Apple Health samples, and the Export share sheet.
- The document scanner on "+".
- "+" then Files › Dropbox and Files › Google Drive, with each app installed: one file
  and one folder from each. A file not yet on the phone should download first, and the
  reading screen should count a folder's reports (US-52 AC10, 2026-10-25).
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
