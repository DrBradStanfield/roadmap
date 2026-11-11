# Switching on the chat question archive (US-15 AC44)

The archive ships off. The daily purge copies no question until the Fly secret
`CHAT_QUESTION_ARCHIVE` is `on`. These steps switch it on, in this order, so
nothing tells customers about a copy we don't keep, and no copy is kept before
customers are told.

1. **Legal basis.** Health details are special-category data under GDPR, so
   keeping them needs an Article 9 condition as well as a lawful basis. Get
   advice on which applies before going further. AC44 states none.
2. **Create the table.** Paste the `chat_question_archive` section of
   `supabase/rls-policies.sql` into the Supabase SQL editor and run it. The
   section ends with `NOTIFY pgrst, 'reload schema'`.
3. **Ship the erase-dialog wording.** Done 2026-10-31 (commit ce5676ed, Brad:
   "switch it on. go live"): item 6 of the erase dialog and the text shown after
   an erase name the kept question copy (`widget-src/src/lib/erase-copy.ts`).
   The held patch is deleted.
4. **Publish the policies.** `node -r dotenv/config scripts/build-privacy-page.mjs connector --publish`,
   the same with `app`, and the guides (`node scripts/publish-guides.mjs --publish`):
   where-your-data-lives and find-your-record describe the copy. Update the
   "Not yet republished" header lines in both addenda.
5. **Switch it on.** `fly secrets set CHAT_QUESTION_ARCHIVE=on` on `health-tool-app`:
   since US-28 AC8 the purge runs only there (`RUN_SHARED_CRONS`), so edu's value
   does not matter.
6. **Check the first run.** The next day's purge log line reads "questions
   archived: N eligible, N kept, N skipped", and a `chat_question_archived`
   product event carries the same counts. Many skips mean the strict checks
   are rejecting good scrubs: look at the counts, never at the questions.

**Status (checked 2026-11-10):** step 3 is done, and ce5676ed (2026-10-31)
says both privacy pages and the guides were republished that day (step 4).
`CHAT_QUESTION_ARCHIVE` is set on `health-tool-app`; its value cannot be read
back, so whether it is `on` is in Fly, not here.

To switch it off: set the secret to anything else. Copies already kept stay
until deleted; the policies must keep describing them while any remain.

The chatbot's saved-chat answers (`app/lib/chat-save-answers.ts`) and the where-your-data-lives guide state the copy as fact: change both if `CHAT_QUESTION_ARCHIVE` is ever turned off.
