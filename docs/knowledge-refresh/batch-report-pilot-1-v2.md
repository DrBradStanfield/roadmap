# Knowledge batch report: pathways-pilot-1-v2

Base: main (efd92a08040758258499881f659a5d11bcf8fd97)
Handles: 10

Counts and hashes only. Raw text never enters this repo.

## Checks

| Check | Status | FAIL | WARN |
|---|---|---|---|
| AC1 index.json and categories.json unchanged (except approved summary corrections) | PASS | 0 | 0 |
| AC2 raw fidelity of every new number token | WARN | 0 | 35 |
| AC3 hedging held; hardening words listed | WARN | 0 | 68 |
| AC4 deleted sentences justified; headings kept | WARN | 0 | 0 |
| AC6 diff touches only batch files | FAIL | 84 | 0 |
| AC7 grokipedia, products, references, banned phrases, exclusions | WARN | 0 | 1 |
| PATHWAY source line, deferral blockquote, no NZ logistics | PASS | 0 | 0 |

## Handles

| handle | type | raw (relative) | raw sha256 | body sha256 | new tokens | quoted | sentences removed | hedge | products |
|---|---|---|---|---|---|---|---|---|---|
| acute-coronary-syndromes-acs | pathway | refresh-2026-09-29/health_pathways/acute-coronary-syndromes-acs.md | b94d90af94905977a16dab75019af58f7d5ebddbcd7adc6ab054716eead7c88d | ba86e58a189b623b | 17 | 17 | 76 | 20>32 | 0>0 |
| cardiovascular-risk-assessment-cvra | pathway | refresh-2026-09-29/health_pathways/cardiovascular-risk-assessment-cvra.md | 80181ccaa54fe3b28cb9bc31baebb6038c7cc70d92872f89ec81b040c7647601 | 35cd1721a8d89814 | 4 | 4 | 24 | 8>13 | 1>1 |
| chronic-non-cancer-pain | pathway | refresh-2026-09-29/health_pathways/chronic-non-cancer-pain.md | 97fe7316402c0ba3ed8b7e63269a3a0efe3eeb48204c89332d1d13abbe50255f | 30a69cc95cc2241d | 9 | 8 | 112 | 11>45 | 0>0 |
| diabetes-screening-and-diagnosis-in-adults | pathway | refresh-2026-09-29/health_pathways/diabetes-screening-and-diagnosis-in-adults.md | cbb8605839a049472cbd53a8d440f761787ca9c82711915ab3bac84669c97577 | 2e56fed1fe62d529 | 18 | 16 | 59 | 16>22 | 0>0 |
| heart-failure | pathway | refresh-2026-09-29/health_pathways/heart-failure.md | da15adfc82ce577e339dab666464bfefb9c1ac6a7c94f6d09c83823b00fd7f34 | 2a11cde8231a8a2e | 16 | 15 | 67 | 29>49 | 0>0 |
| hyperlipidaemia | pathway | refresh-2026-09-29/health_pathways/hyperlipidaemia.md | 5defd74865b8be410e737742eab633e8f3b22b73d072bb8be781c87d6a3c360d | 4cd9f703a008514a | 7 | 7 | 34 | 18>20 | 1>1 |
| hypertension-in-adults | pathway | refresh-2026-09-29/health_pathways/hypertension-in-adults.md | cab687eca2d723470afa8fc0a4628681ec4a87894c04944bf36d3c13198ab7b1 | 730c5caff4cb4a9b | 17 | 16 | 56 | 11>21 | 0>0 |
| non-insulin-diabetes-medications | pathway | refresh-2026-09-29/health_pathways/non-insulin-diabetes-medications.md | 1564e57395c097c5b0b62e450b9b55142677d6a16329ac8d0ece32afcdb7c761 | 8055a3fb30f0f37c | 6 | 5 | 59 | 9>17 | 0>0 |
| osteoarthritis-oa | pathway | refresh-2026-09-29/health_pathways/osteoarthritis-oa.md | b9df834bbac7498bfb7078771217c037445bb6e79789c78643119990e07a7951 | 59c422049e28b74b | 7 | 7 | 50 | 30>38 | 0>0 |
| type-2-diabetes | pathway | refresh-2026-09-29/health_pathways/type-2-diabetes.md | 03e71ba27336f2fca4cf0e1a34ec7c1b752fd5546194d9e28d3dee616a2885c3 | e304c90159d5322a | 44 | 43 | 89 | 22>47 | 0>0 |

## Accepted exceptions

| check | handle | by | date | reason | match sha256 |
|---|---|---|---|---|---|
| AC2 | cardiovascular-risk-assessment-cvra | orchestrator | 2026-10-08 | The scrape prints the nephropathy thresholds bare; the entry keeps 'or more' following HISO 10071:2019, which defines them as floors (Codex content review R1, 2026-10-08). FOR BRAD to confirm. | 1ef5349189334743 |
| AC2 | diabetes-screening-and-diagnosis-in-adults | orchestrator | 2026-10-08 | The source writes the men's waist cutoff as 'more than 90 in men' with no unit beside it; the unit is clear from the paired 80 cm figure. Ruled 2026-09-29. | d05a5d3dceb45627 |
| AC2 | heart-failure | orchestrator | 2026-10-08 | The source says 'Use 1.5 litres as a starting point' for a temporary fluid restriction; the entry adds 'per day', which every fluid restriction means, so a patient is not misled. Orchestrator 2026-10-08. | 4de8eddb55d4c5e7 |
| AC2 | hyperlipidaemia | orchestrator | 2026-10-08 | As for CVRA: 'or more' follows HISO 10071:2019 (Codex content review R1, 2026-10-08). FOR BRAD to confirm. | ac38cfec603dc6d2 |
| AC4 | diabetes-screening-and-diagnosis-in-adults | orchestrator | 2026-10-08 | The source replaced the pre-July 2026 thresholds; the heading is renamed to Current Diagnostic Thresholds. Ruled 2026-09-29. | 6054e70899e9afa2 |
| AC4 | heart-failure | orchestrator | 2026-10-08 | The source now defines HFrEF as 40% or less; the heading follows it. Ruled 2026-09-29. | 6d709d39f03c2f7d |

Body hashes are the first 16 hex characters of sha256; raw hashes are in full.

## Not covered by this script

- AC5 answer checks (harness)
- AC6 Shopify updated_at snapshot (separate tool)
- DOI/PMID resolution: NOT checked (run with --check-ids)
- section placement of edits (R8)
- primary-study abstract presence (only the WARN "unverified primary" lines)

AC8 sign-off (Brad): PENDING
