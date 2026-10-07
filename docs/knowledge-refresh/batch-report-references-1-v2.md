# Knowledge batch report: references-1-v2

Base: main (f19dc38e29c16df22922a9afa6460110217af9fe)
Handles: 5

Counts and hashes only. Raw text never enters this repo.

## Checks

| Check | Status | FAIL | WARN |
|---|---|---|---|
| AC1 index.json and categories.json unchanged (except approved summary corrections) | PASS | 0 | 0 |
| AC2 raw fidelity of every new number token | WARN | 0 | 89 |
| AC3 hedging held; hardening words listed | WARN | 0 | 143 |
| AC4 deleted sentences justified; headings kept | WARN | 0 | 9 |
| AC6 diff touches only batch files | FAIL | 99 | 0 |
| AC7 grokipedia, products, references, banned phrases, exclusions | WARN | 0 | 1 |
| PATHWAY source line, deferral blockquote, no NZ logistics | PASS | 0 | 0 |

## Handles

| handle | type | raw (relative) | raw sha256 | body sha256 | new tokens | quoted | sentences removed | hedge | products |
|---|---|---|---|---|---|---|---|---|---|
| creatine-benefits-best-forms-dosing-and-side-effects | reference | refresh-2026-09-29/consumerlab/review/reviews-review-creatine-creatine.md | 2d8545d21a72a758f870c48d82107f53aa07bfbf4f033911cc0df320e33d6eb6 | c39094d426995c9e | 31 | 30 | 227 | 71>79 | 3>3 |
| lithium-benefits-forms-dosing-and-side-effects | reference | refresh-2026-09-29/consumerlab/review/reviews-lithium-low-dose-supplements-lithium.md | e0e6d307c853f46829cde15abbfc43c979867adaad53f0491ca42c4bc7f85ecf | 4fd89b8c177c275a | 52 | 51 | 263 | 52>33 | 0>0 |
| magnesium-benefits-best-forms-dosing | reference | refresh-2026-09-29/consumerlab/review/reviews-magnesium-supplement-review-magnesium.md | c697a6973e90202e5170e509b74b888e3ca1cea57e3e901e10217022e474c815 | d46355ca12a55c33 | 29 | 30 | 161 | 49>57 | 0>0 |
| taurine-benefits-forms-dosing-and-side-effects | reference | refresh-2026-09-29/consumerlab/review/reviews-taurine-supplements-review-taurine.md | 34dd95389868356b5a2aa5ef4099ab49cc3b899c2c0bc3ea66a4918f5aceacb0 | c16ad5f2fce1d908 | 10 | 11 | 189 | 55>43 | 4>4 |
| vitamin-k-benefits-forms-dosing-and-side-effects | reference | refresh-2026-09-29/consumerlab/review/reviews-vitamin-k-supplements-review-vitamin-k.md | 4df6c8fd2890b327679d282691233b18cc9bcc17681967103e051b83c596f8cd | bc3c27a005fae6b2 | 26 | 26 | 301 | 96>82 | 3>3 |

## Accepted exceptions

| check | handle | by | date | reason | match sha256 |
|---|---|---|---|---|---|
| AC2 | creatine-benefits-best-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The cited abstract gives the dose as '0.3 g·kg-1·d-1'; the body says '0.3 g for each kilogram'. Same dose; the checker cannot read the dot-operator notation. Orchestrator 2026-10-08. | 21a21218bf686b22 |
| AC2 | creatine-benefits-best-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | As above: 0.3 g per kg (the abstract's '0.3 g·kg-1·d-1'). Orchestrator 2026-10-08. | 655c634810c0ad03 |
| AC2 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The source gives 28 to 113 mg with 'given daily' later in the same sentence; same dose. Orchestrator 2026-10-08. | a5d92b45a4e56278 |
| AC2 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The source says 'daily doses ... 0.3 mg to 5 mg'; the daily word comes before the range. Same dose. Orchestrator 2026-10-08. | 93140d54bba324ca |
| AC2 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The abstract says '400 micrograms/d'; the body gives 400 micrograms with its frequency in words. Same dose. Orchestrator 2026-10-08. | bacb0bd05f713c26 |
| AC2 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | As above: 'daily doses ... 0.3 mg to 5 mg'. Orchestrator 2026-10-08. | 9c6e542284af3ad8 |
| AC4 | creatine-benefits-best-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The creatinine blood-test advice was deleted in a first pass and rightly restored (ConsumerLab notes creatine raises serum creatinine); the stale deletion claim stays in the append-only report. Orchestrator 2026-10-08. | 3efd7f67d52d752e |
| AC4 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia; no ConsumerLab, NIH or PubMed support. Removed on the 2026-09-29 ruling: an empty heading is worse than none. | ae293a389c3082ea |
| AC4 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia. Removed on the 2026-09-29 ruling. | 706794e5d531acc6 |
| AC4 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia; the supported BDNF finding now sits under the cognition section. Removed on the 2026-09-29 ruling. | ead199dd8d93cb08 |
| AC4 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia. Removed on the 2026-09-29 ruling. | 6e0a9c9652befc2c |
| AC4 | lithium-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia. Removed on the 2026-09-29 ruling. | 454914ad97ed1f18 |
| AC4 | vitamin-k-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | Section rested only on Grokipedia. Removed on the 2026-09-29 ruling. | c09ab59cede3acfc |
| AC4 | vitamin-k-benefits-forms-dosing-and-side-effects | orchestrator | 2026-10-08 | The interaction rested only on Grokipedia; listed under SAFETY for Brad. Removed on the 2026-09-29 ruling. | f54850a01674aa13 |

Body hashes are the first 16 hex characters of sha256; raw hashes are in full.

## Not covered by this script

- AC5 answer checks (harness)
- AC6 Shopify updated_at snapshot (separate tool)
- DOI/PMID resolution: NOT checked (run with --check-ids)
- section placement of edits (R8)
- primary-study abstract presence (only the WARN "unverified primary" lines)

AC8 sign-off (Brad): PENDING
