# Review details for 1.0.2 (dashboard only, never in the ZIP)

OpenAI's plugin ZIP rejects `test_credentials` and `reviewer_instructions`. Reviewer access goes in
the dashboard: **Metadata & Skills → Review information → Review details**, then **Save details**
(https://developers.openai.com/plugins/deploy/submission#complete-review-information). Paste the
block below there, with the real username and password from Brad's private credentials file in
place of the placeholders. This repository is public: real values never go in it.

This file is the only home of the Variant C paste block; [the listing](../chatgpt-app-listing.md#variant-c-sign-in-on-our-own-consent-page-102)
says why Variant C replaced A and B. It ends with the sample report positive test case 4 attaches. The box on the consent page shows only while
the three reviewer secrets are set ([runbook](../deploy-runbook-mcp.md#the-openai-reviewer-sign-in-us-32-ac38)).

> Login URL: https://chatgpt.com (there is no separate login page; follow the steps below)
> Username: `[REVIEWER_USERNAME]`
> Password: `[REVIEWER_PASSWORD]`
>
> Sign-in steps:
> 1. Connect Health by Dr Brad in ChatGPT.
> 2. Our page opens with a box headed "OpenAI app reviewers: sign in here". Enter the username and password above and press **Sign in**. The password is 26 letters and digits, shown in groups of four; spaces, dashes and capitals do not matter.
> 3. You return to ChatGPT connected. There is no Dropbox or Google sign-in, no code and no email.
>
> Please do not press Continue to Dropbox or Google Drive: those buttons are for real users and their own accounts.
>
> This account is ours, made for your review. It holds invented data, not a real person's record, and already has a profile and results, so every test case works immediately. Earlier reviewers may have added rows; the test cases allow for that. Bug reports (`report_feedback`) are limited to 3 a day for all reviewer sessions together, so that tool may refuse late in a busy day.
>
> Positive test case 4 uses a synthetic lab report, invented data for app review: https://cdn.shopify.com/s/files/1/0790/6109/0503/files/sample-lab-report.pdf?v=1790902633. Download it and drop it into the chat. Please keep its file name: a second upload of the same file is reported as already imported, which the test case allows.
