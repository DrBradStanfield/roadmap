---
title: Claude connector directory submission
artifact: https://claude.ai/artifact/DtuWzZ8RxQeLdxvqA8p1Bg
---

# Claude connector directory: Health by Dr Brad

Answers for each step of the submission form at **claude.ai/directory/manage → Submit new → MCP connector**. A paid Claude account (Pro, Max, Team or Enterprise) submits; on Team or Enterprise, an Owner. Requirements read 2026-10-20 from claude.com/docs/connectors/building/submission, .../review-criteria, .../authentication and the Anthropic Software Directory Policy.

**Before you submit (in this order):**

1. **Deploy PR #202.** Until it is live, Anthropic's reviewer sees no sign-in box and would have to log in to Dropbox, which is the challenge that got OpenAI's 1.0.1 rejected.
2. **Decide the two add-tool labels (below).** The portal flags any tool that is neither read-only nor destructive.
3. **Turn the box on for Anthropic** just before you submit: `fly secrets set MCP_REVIEWER_VENDORS=openai,anthropic -a health-tool-edu`. Until then real Claude users never see the reviewer box. OpenAI declined its review on scope 2026-10-29, so the value is now `anthropic` alone. After Anthropic's verdict, unset the three reviewer secrets and delete the reviewer code (Brad 2026-10-29; [chatgpt-app-listing.md](chatgpt-app-listing.md) says how to bring it back).
4. **Do not mint new reviewer credentials.** OpenAI's 1.0.2 review uses the same ones. Running `--mint` or `--password` again ends OpenAI's reviewer sessions.

## The open decision: two tool labels

Anthropic's checklist asks every tool for a title plus `readOnlyHint: true` or `destructiveHint: true`. All nine tools have titles. Seven pass. `add_measurement` and `add_lab_values` are marked neither, because they only ever add a row and never change or remove one.

- **Mark both destructive.** Claude then asks before every add. It is the conservative reading, and it passes the check. ChatGPT reads the same labels, so its approval prompt changes too, and OpenAI's tool scan would differ from the 1.0.2 submission while it is in review.
- **Leave them.** The portal flags them. A reviewer may accept the explanation in the form (append-only, refused on a duplicate day), or may ask for the change.

Recommendation: submit with them unchanged and the explanation below. Flip them after OpenAI's verdict if Anthropic asks.

## 1. Connection

- Server URL: `https://mcp.drstanfield.com/mcp`
- Users connect to different URLs: **No.** One URL for everyone.

Checked live 2026-10-20: an unauthenticated request answers 401 with `WWW-Authenticate: Bearer resource_metadata=...`; the protected-resource metadata names `https://mcp.drstanfield.com/mcp` exactly; the authorization server advertises client metadata documents, `none` token auth and PKCE S256.

## 2. Tools

Synced from the server. Nine tools, all titled.

| Tool | Read-only | Destructive |
| --- | --- | --- |
| `read_record` | yes | no |
| `get_plan` | yes | no |
| `add_measurement` | no | no (see above) |
| `add_lab_values` | no | no (see above) |
| `correct_value` | no | yes |
| `update_profile` | no | yes |
| `report_feedback` | no | yes |
| `import_documents` | no | yes |
| `file_results` | no | yes |

If the form asks why the two add tools are neither: *"Both only append a new row to the user's own record file. They never change or remove an existing row, and a second value for the same test on the same day is refused, with a pointer to `correct_value`, which is marked destructive."*

## 3. Listing

- **Server name (100):** Health by Dr Brad
- **One-liner (200):** Keep your health record in your own Dropbox or Google Drive, and get a health plan from it: which screening is due and evidence-based suggestions with citations.
- **Description (2,000):**

> Health by Dr Brad works out a health plan from your own results: which screening is due at your age, and evidence-based suggestions, each with the reason and the published guideline or study behind it.
>
> In Claude you can ask what your plan says next, add measurements and lab results, file the results from a lab report you share in the chat, and correct a value entered wrongly. For a test our catalogue knows, the unit is checked before the result is saved, and a unit we do not recognise is refused rather than guessed.
>
> Your record is a single file, health-roadmap.json, in your own Dropbox or Google Drive. We keep no copy of your record and never store your cloud credential. Values are never deleted: a correction adds the new number and marks the old one entered-in-error, so your history stays auditable. The same record works on the website at drstanfield.com/pages/roadmap, which is free and needs no account.
>
> You can disconnect at any time at dropbox.com/account/connected_apps or myaccount.google.com/connections. The code is open source at github.com/DrBradStanfield/roadmap.
>
> This is educational information, not medical advice, and does not replace your doctor.

- **Categories (1 to 5):** Health (or the nearest health or wellness category), Productivity if a second is wanted.
- **Documentation URL:** https://drstanfield.com/blogs/guides/connect-claude
- **Privacy policy URL:** https://drstanfield.com/pages/connector-privacy
- **Support contact:** brad@drstanfield.com
- **Icon:** `demo-video/public/app-icon.png`, the one in the ChatGPT package.
- **URL slug (permanent):** `health-by-dr-brad`

## 4. Use cases

**Primary use cases** (the policy needs at least three working prompts):

1. "What's in my health record?" Reads the record: profile, measurements, lab results, medications, supplements, screenings.
2. "What does my health plan say I should do next?" Computes due screening and suggestions with citations. Writes nothing.
3. "Show me how my LDL has changed over the past year." Reads one metric's history.
4. "Record my weight on 2 March 2026 as 78 kg." Adds one measurement.
5. "My most recent ferritin should be 10 ug/L higher than it shows." Corrects a value after the user confirms in their own words.

**What users need before connecting:** a free Dropbox or Google Drive account. No account with us. Nothing to install.

**Reads, writes or both:** both. Reads the user's own record file; writes only to that file, in the user's own cloud.

## 5. Company

- **Name:** Dr Brad, Inc
- **Website:** https://drstanfield.com
- **Primary contact for review updates:** brad@drstanfield.com

## 6. Authentication

**OAuth with client ID metadata documents (CIMD).** Claude connects with its pinned client id `https://claude.ai/oauth/mcp-oauth-client-metadata` and returns to `https://claude.ai/api/mcp/auth_callback`. Claude Code uses its own pinned id with loopback callbacks. Dynamic client registration also works. Not lazy auth: every tool needs the user's connection.

## 7. Data handling

- **Whose API:** ours. The server is our own; it reads and writes the user's file in the user's own Dropbox or Google Drive over the user's own grant.
- **Handles personal health data:** **Yes.** Say so plainly. Explain in the free text:

> The user's health record lives in their own Dropbox or Google Drive. To answer one tool call the server fetches that file over the user's own credential, holds it in memory for that request, and writes it back if the call was a write. Nothing is persisted: no per-user row, no health table, no health values in logs, error reports or analytics. The one exception is `import_documents`: when the user asks to import files from their Dropbox folder, those files (never the record) go to Anthropic's API for extraction, and we keep nothing. We collect no conversation text.

## 8. Test and launch

Paste into the test-account field, with the real username and password from Brad's private credentials file (`~/Documents/openai-reviewer-credentials.txt`, the same pair OpenAI's reviewer uses). This repository is public: real values never go in it.

> This account is ours, made for your review. It holds invented data, not a real person's record, and already has a profile, measurements and lab results, so every use case works immediately.
>
> 1. In Claude, add the connector https://mcp.drstanfield.com/mcp and press Connect.
> 2. Our consent page opens with a box headed "Anthropic reviewers: sign in here".
> 3. Username: `[REVIEWER_USERNAME]`. Password: `[REVIEWER_PASSWORD]`. Spaces, dashes and capitals in the password do not matter; type the username exactly.
> 4. Press Sign in. You return to Claude, connected. There is no Dropbox or Google sign-in, no code, no email and no MFA.
>
> Do not press "Continue to Dropbox" or "Continue to Google Drive"; those are for real users.
>
> Changes that cannot be undone (a correction, a profile change) ask you to confirm in your own words. A short sentence such as "Yes, apply the correction" works best.
>
> Other reviewers share this record, so it may hold rows earlier reviewers added. That is expected. A second weight on a day that already has one is refused and a correction is offered instead: one value per test per day.

Confirm you ran every tool through Claude as a custom connector. Do that run on the reviewer account after #202 deploys, not on your own record.

## 9. Compliance

Seven acknowledgements. Nothing here conflicts: no money movement, no AI media generation, no ads or sponsored content, first-party API only, public documentation exists (the guide above), and tool descriptions carry no instructions to call other tools.

## 10. Review and submit

Read the quality warnings before submitting. Review time is not fixed. Feedback arrives by email to the primary contact and under "View feedback" in the portal. Escalations: mcp-review@anthropic.com with the listing name, organisation and portal status. After approval you press **Publish**; editing before then returns it to draft.
