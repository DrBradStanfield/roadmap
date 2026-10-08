# Batch 2: adversary findings and rulings (orchestrator, 2026-10-08)

Fresh Opus adversary on knowledge-refresh/review-batch-2 (8cd8882a). Line numbers are file lines on that commit.

| # | Handle | Finding | Ruling |
|---|---|---|---|
| 1 | headaches-in-adults L32-35, L72 | Raw "Concerning features and risk factors for a serious secondary cause" (new headache with anticoagulation or dual antiplatelets, HIV or immunosuppression, pregnancy or postpartum, cancer history; severe enough to wake, or present on waking) leads to "emergency assessment or acute neurosurgery assessment". The body gives only the over-50 factor an action and invents a same-day tier. | ACCEPT. Group them under "call 111 or go to the emergency department" as the raw groups them (ruling 2). Remove the invented same-day tier. Restore "severe enough to wake you, or present on waking". |
| 2 | cardiac-drugs-and-monitoring L37, L39 | 111 for ketones over 1.5 mmol/L and for confusion; the raw says "urgent general medical advice". | DISPUTED. House safety rule, the same lines Brad signed in the pilot (non-insulin-diabetes-medications, AC8 2026-10-08). Now ruling 11. Fix the stale report note that says "not 111", and L554 if it contradicts. |
| 3 | insulin-for-type-2-diabetes L201 | The unconscious, seizure or cannot-swallow line is not in the raw. | DISPUTED. House safety rule (pilot type-2-diabetes, signed). Ruling 11. Note it in the report. |
| 4 | direct-oral-anticoagulants L27-34 | Bad headache, dizziness and coughing up blood get an invented lower tier under "When to Seek Emergency Care". | ACCEPT. List them as signs of serious bleeding under the 111 line (raw L139, L232). |
| 5 | gout L24-25 | The same-day tier and the "first such episode" clause are not in the raw. | ACCEPT. Remove both. Keep the facts as background. |
| 6 | syncope-and-presyncope L52 | Raw red flag "Abdominal or back pain (leaking aortic aneurysm, ruptured ectopic pregnancy)" was dropped. | ACCEPT. Add it to the 111 group. |
| 7 | vitamin-d-deficiency-in-children L199, L211, L232 | Lab results that trigger "acute paediatric assessment" say "urgent hospital assessment", not the ruling 2 wording. | ACCEPT (reversed after Codex R1). Parents can see results in a patient portal before the doctor calls, and the raw says the hypocalcaemia may have no symptoms. Corrected calcium less than 2 mmol/L, and every finding the raw sends for acute paediatric assessment, get "call 111 or go to the emergency department" whatever the symptoms. |
| 8 | eye-disease-in-diabetes L141 | Ruling 2 wording altered. | ACCEPT. "call 111 or go to the emergency department". |
| 9 | cardiac-drugs-and-monitoring L25 vs L43, L96 | The raw groups "palpitations, syncope, or abnormal shortness of breath"; the body splits them. | ACCEPT. One action for the group, the one the raw context supports. |
| 10 | CKD, DOAC, insulin | "below/under" where the raw says "less than" (ruling 3). | ACCEPT. Follow the raw comparator on every flagged line. |
| 11 | cardiac-drugs-and-monitoring L5-6, L444 | Frontmatter still names prasugrel; the metolazone starting dose of 2.5 mg was dropped. | Metolazone: ACCEPT, restore. Frontmatter: FOR BRAD (summary correction on the sign-off sheet). |
| 12 | ACE/ARB vs CKD | The 2019 ACE/ARB raw says stop if eGFR falls by more than 25% at 1 week; the 2025 CKD raw says withhold if creatinine rises by 30% or more. DOAC and AF raws are past their review dates. | FOR BRAD (sign-off sheet). Both are faithful to their sources. |

## Codex (gpt-6.1-sol, snapshot 1af613b7+e6c5417c+48feeb11, status incomplete: it could not verify AC5)
- R1 (vitamin D children, calcium less than 2 mmol/L without symptoms): ACCEPT, see row 7.
- R2 (no AC5 fixtures for batch 2): ACCEPT. Pre-register fixed-handle answer checks for the 20 handles now; run them with the pilot's after 2026-11-01 (Brad's deferral).
