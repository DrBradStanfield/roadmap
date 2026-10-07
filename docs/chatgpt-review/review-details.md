# Review details for 1.0.2 (dashboard only, never in the ZIP)

OpenAI's plugin ZIP rejects `test_credentials` and `reviewer_instructions`. Reviewer access goes in
the dashboard: **Metadata & Skills → Review information → Review details**, then **Save details**
(https://developers.openai.com/plugins/deploy/submission#complete-review-information). Paste the
block below there, with the real username and password from Brad's private credentials file in
place of the placeholders. This repository is public: real values never go in it.

This file is the only home of the Variant C paste block; [the listing](../chatgpt-app-listing.md#variant-c-sign-in-on-our-own-consent-page-102)
says why Variant C replaced A and B. It ends with the sample report positive test case 4 attaches. The box on the consent page shows only while
the three reviewer secrets are set ([runbook](../deploy-runbook-mcp.md#the-openai-reviewer-sign-in-us-32-ac38)).

> Login URL: https://chatgpt.com
> Username: `[REVIEWER_USERNAME]`
> Password: `[REVIEWER_PASSWORD]`
>
> Instructions:
> These are not ChatGPT credentials: type them into our page that opens when you connect Health by Dr Brad. Please test in ChatGPT.
>
> Sign-in steps:
> 1. Connect Health by Dr Brad in ChatGPT.
> 2. Our page opens with a box headed "OpenAI app reviewers: sign in here". Enter the username and password above and press **Sign in**. The password is 26 letters and digits, shown in groups of four; in the password, spaces, dashes and capitals do not matter. Type the username exactly.
> 3. You return to ChatGPT connected. There is no Dropbox or Google sign-in, no code and no email.
>
> Please do not press Continue to Dropbox or Google Drive: those buttons are for real users and their own accounts.
>
> This account is ours, made for your review. It holds invented data, not a real person's record, and already has a profile and results, so every test case works immediately. Earlier reviewers may have added rows; the test cases allow for that. Bug reports (`report_feedback`) are limited to 3 a day across all reviewer sessions together, so that tool may refuse even if you have filed none.
>
> Confirming a change: when ChatGPT asks you to confirm a correction, a profile change or the lab results to file, please answer with a short sentence such as "Yes, apply the correction" or "Yes, add them". ChatGPT's own safety check blocks a permanent write approved by a bare "yes" (tested 2026-10-07: 8 of 8 sentence replies wrote, 0 of 3 bare "yes").
>
> Health data: the record is the user's own file in their own Dropbox or Google Drive. Our server processes it in memory for one request, after the user's consent screen, and stores none of it. The folder-import route sends the user's lab files, never the record, to Anthropic's API for extraction; we keep those files nowhere.
>
> Tool annotations: seven tools work only inside the user's own private storage: their Dropbox app folder, or on Google Drive the files our app created (drive.file scope). Following the plugin guidelines (a bounded private account may use false even when externally hosted), they declare openWorldHint false. report_feedback (files a GitHub issue) and import_documents (sends lab files to Anthropic's API for extraction) declare true.
>
> Positive test case 4 uses a synthetic lab report, invented data for app review: https://cdn.shopify.com/s/files/1/0790/6109/0503/files/sample-lab-report.pdf?v=1790902633. Download it and drop it into the chat. Please keep its file name: a second upload of the same file is reported as already imported, which the test case allows.
