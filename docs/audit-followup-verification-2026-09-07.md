# Audit follow-up verification, 7 September 2026

Implemented: value-free main-LLM/router/classifier failure telemetry;
explicit local-first data imports; removal of retired server CRUD,
account-era branches, write-only flags and orphan CSS; truthful local history
loading; strict server typechecking; an asserting WebKit deployment probe.

Not changed: clinical rules, conversation storage/retention, Drive consistency,
Sentry bundle URL filters, medication annotations or the proposed mobile UX.
The latter decisions are explained in audit-followup-plan-2026-09-07.md.

The shared checkout received another session's MCP implementation during
validation. This candidate was isolated at base 3886acc on
claude/audit-followup-hardening. It includes only the audit fixes and their
documentation; the in-progress connector implementation was not modified.

## Tests and builds

- 118 suites and 2,196 tests pass on the isolated candidate.
- Strict widget, health-core and server TypeScript checks pass.
- Server, Shopify main/upload, side-bundle and Pages builds pass.
- User-story HTML regenerated; products symlink guard and diff checks pass.
- Tests use a temporary Vite filesystem allowance for symlinked installed
  dependencies in the isolated checkout. No change to test selection,
  aliases, assertions or shipped configuration was needed.
- Build runs explicitly disabled Sentry publishing. No deployment or
  source-map/release upload was performed.

## Browser evidence

- Real WebKit passes on desktop and iPhone against the public storefront and
  the newly built local Pages UI, using disposable synthetic records.
- The gate checks actual numeric text, element and ancestor visibility,
  numeric/cell geometry, border-box sizing, exact seeded values and overflow.
- Injecting display:none on result cells makes the probe exit 1.
- Injecting display:none on just their numeric spans also makes it exit 1.
- Non-read requests and third-party telemetry were blocked during WebKit
  checks; no real records or messages were submitted.
- Chrome inspected the new local Pages build: basic entry, progressive
  rendering and responsive layout worked, with no retired CRUD requests.

## Adversarial review

Requested reviewer: gpt-6-astra, high reasoning, fresh context.

First pass found two gaps: provider/model parsing text could still reach
router/classifier telemetry, and the WebKit collector measured a header
while merely counting potentially hidden results. Follow-up also required
checking visibility of the number itself inside each result cell.

All were corrected. The telemetry fixtures inspect complete SDK transport
envelopes, including malformed transport JSON, malformed model output and
classifier echoes. Raw conversation/error storage remains unchanged.
The reviewer rechecked the final files and reported no blockers in scope.

## Deletion accounting

Net production source: -1,364 nonblank, noncomment lines. Counted app,
widget/standalone and health-core runtime source, including CSS; excluded
tests, generated bundles and build/test tooling. Comments were removed
using TypeScript parser comment ranges and CSS block-comment ranges.

Deleted the retired api.ts CRUD implementation and override mechanism,
unreachable login/cache-replay/report branches, write-only account status
helpers, fake local-history pagination and orphan selectors. Kept the old
cache mirror that still serves the separate storefront chat context reader.
No dependency was added.
