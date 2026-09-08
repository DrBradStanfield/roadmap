# Sentry bundle-filter verification (PR #73 probe)

One-off probe note for PR #73, moved here from `docs/` on 2026-09-09 (a
one-off verification is a loop report, not a `docs/` file). The gotcha
itself is archived in `docs/reference.md`.

PR #73 changes only the client source allow-list. Actual SDK-filter tests use
the production init options and filenames from the build configs: 16 passing (the
test did not exist against the old filter, so there is no "before" count). Full suite: 2,247 passed, 3 opt-in integration tests
skipped. Widget/core checks and Shopify/side/Pages builds pass.

## Live-origin candidate check

In an isolated Chrome context on drstanfield.com, temporarily applied the PR's
filter to the existing Sentry client. Used clean scopes and synthetic
exceptions with explicit stack URLs for five existing deployed assets. HEAD
requests confirmed each file existed. The events contained no health data.

The UI-review context originally blocked POSTs. Its first probes therefore
failed locally; they were not mistaken for successful verification. For the
successful probes, temporarily used the SDK transport with the original fetch
implementation, restoring both transport and filter afterward.

All five ingest requests returned HTTP 200. Sentry's event API subsequently
returned each exact event ID:

| Bundle | Event ID |
| --- | --- |
| health-plan-v2.js | 75327496ccea4ec392bf2cd255ddc1f5 |
| health-plan-v2-HistoryPanel.js | 7ae8c8c7a39b466baf223bfaf2a6b477 |
| health-upload.js | 97bb2e21dffe4a62a37ea0d12b95b475 |
| health-site-chat.js | 655f00b181924821822fa70a200a1499 |
| health-chatbot-embed.js | 5f758ebcb32a41d4a9125d610b242839 |

These are synthetic SDK/filter/transport probes with supplied stack URLs,
not naturally occurring errors or proof of a deployed fix. The production
filter was not changed. A post-deployment smoke event should still confirm
the new version is loaded on each deployed surface. Pages URL acceptance is
covered locally by the SDK tests; its new live runtime was not deployed here.

## Cleanup

The five probes formed Sentry issue `7716241012` (environment
`bundle-filter-verification`, 5 events). The sentry-fix loop ledgered it
wontfix on 2026-09-07; it was still `unresolved`, so it was resolved via
`PUT /api/0/issues/7716241012/ {"status":"resolved"}` on 2026-09-09 during
the PR #73 review fixes. The environment name remains in the project.
