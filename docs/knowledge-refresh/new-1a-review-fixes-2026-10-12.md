# new-1a: review findings and rulings (orchestrator, 2026-10-12)

Fresh Opus adversary on knowledge-refresh/review-new-1a (4b23d30b). Line numbers are body lines on that commit.

| # | Handle | Finding | Ruling |
|---|---|---|---|
| 1 | hoarse-voice L24; dyspepsia L21-27; IBD L25 | Ruling 2 applied literally sends slow signs (hoarseness over 4 weeks, iron deficiency anaemia, weight loss, difficulty swallowing) to 111 because the raw files all red flags under "acute ... assessment". Entries then contradict their own referral sections. | ACCEPT, new ruling 12. Emergency symptoms the reader feels now keep 111 (stridor, cannot swallow saliva, vomiting blood, black stools, severe pain, heavy bleeding). Slow or background signs (symptoms lasting weeks, weight loss, a blood-test finding such as anaemia) get "see your doctor the same day"; the doctor arranges the acute assessment. IBD: 111 only for the raw's severe flare features; read the raw. FOR BRAD (sheet). |
| 2 | general-wound-care L23; dysphagia L28 | Possible necrotising fasciitis and systemic infection get no timing; stridor in dysphagia gets no action, while eczema and hoarse-voice give 111. | ACCEPT, ruling 11 house lines: spreading skin infection with fever, shivering or a racing heart, or pain far worse than the wound looks: "call 111 or go to the emergency department". Stridor (noisy, high-pitched breathing): 111. |
| 3 | anxiety-in-adults L21-22 | "High risk of suicide" is not a trigger a reader can judge; "Tell your doctor" has no timing. | ACCEPT, ruling 11 house line: "If you are thinking about suicide, see your doctor the same day, or call or text 1737 (free, any time). If you have a plan or feel you might act on it, call 111 or go to the emergency department." |
| 4 | HIV L103-106, L200 | CD4 values lack the raw's unit. | ACCEPT: "cells × 10⁶/L" as the raw gives. |
| 5 | IBD L30-31 | "Hb less than 105", "CRP more than 30" have no units (nor does the raw). | ACCEPT: add g/L and mg/L, the NZ reporting units; an exception records that the raw prints none. FOR BRAD (sheet). |
| 6 | dysmenorrhoea L39 | Risk factors beyond smoking are not in the raw. | REVERSED on checking: the raw lists all five ("Longer duration of menses, early menarche, smoking, alcohol, and obesity are all risk factors associated with dysmenorrhoea"). Entry unchanged. |
| 7 | cognitive-impairment L163 | EPA activation sentence contradicts the raw (EPA Property can be active from set-up). | ACCEPT: add the exception. |
| 8 | abortion L125-128 | Day 1 baseline beta hCG test dropped; completion at L165 relies on it. | ACCEPT: restore "if possible, a blood test for beta hCG". |
| 9 | contraceptive-implant L51 | Contraindication widened to past breast cancer. | ACCEPT: "active breast cancer". |
| 10 | adhd L21 | Behaviour trigger lost. | ACCEPT: restore "severe behaviour problems threatening the safety of the child or others: your doctor may notify Oranga Tamariki or the police"; immediate danger keeps 111. |
| 11 | abortion L224, L228 | "acute" dropped from gynaecology advice; uterine injury lacks the 111 wording. | ACCEPT. |
| 12 | epilepsy; cognitive-impairment L34; abortion L177 | No status epilepticus line; sudden confusion gets "Tell your doctor"; heavy bleeding (2+ pads an hour for 2 hours) has no timing. | ACCEPT, ruling 11 house lines: a seizure lasting more than 5 minutes, or seizures one after another without recovery: 111. Sudden confusion: "see your doctor the same day" (111 if very drowsy or hard to wake). Heavy bleeding: "contact your abortion provider straight away; if you feel faint or dizzy, call 111 or go to the emergency department". |

## Codex (gpt-6.1-sol, snapshot 04c9afde+2c4e5aee+cc1eeb59, status incomplete: AC5 not run)
- R1 (antenatal calcium: brand dropped, dose now ambiguous): ACCEPT. "Two tablets a day, each giving 500 mg of elemental calcium (1.25 g calcium carbonate)".
- R2 (anxiety: "escitalopram does not appear to carry QT risk"): ACCEPT, SAFETY CORRECTION against the raw (MHRA: dose-dependent QT prolongation with citalopram and escitalopram). Remove the reassurance; say both can affect heart rhythm (QT interval). FOR BRAD.
- R3 (dyspepsia pregnancy section repeats weight loss and limiting alcohol): ACCEPT, SAFETY CORRECTION against the raw. In pregnancy: no weight-loss advice; avoid alcohol. FOR BRAD.
- R4 (necrotising fasciitis): ACCEPT, same as adversary row 2.
- R5 (implant: non-radiopaque warning extended to all etonogestrel implants): ACCEPT. Only the older Implanon is not radiopaque; Implanon NXT can be found by X-ray.
- R6 (familial cancer: public-service eligibility restriction): ACCEPT, remove (rule 4, AC9).
- R7 (AC5 not run): DISPUTED. Brad deferred all AC5 runs to after 2026-11-01; the 40 fixtures are pre-registered.

Applied 2026-10-12 by one Opus worker: every ACCEPT row. Ruling 12 decisions: hoarse voice (stridor, coughing up blood -> 111; the slow signs -> same day), dyspepsia (vomiting blood, black stools, persistent vomiting -> 111; difficulty swallowing, weight loss, anaemia, abdominal lump -> same day), IBD (fever, fast heart rate, low blood pressure, acute severe flare -> 111; abdominal pain -> same day, severe pain -> 111). Epilepsy gains a red-flag section for the seizure house line.

## Codex round 2 (gpt-6.1-sol, snapshot 4df581d9+255977d2+ee7f76c9, status incomplete: AC5 not run). Rounds now capped; fixes below are NOT YET APPLIED.
- R1 (IBD L156: no live vaccines for 6 months after infliximab exposure in pregnancy): ACCEPT, SAFETY CORRECTION, FOR BRAD. Medsafe Remicade data sheet: 12 months (fatal disseminated BCG recorded); the baby's doctor decides timing.
- R2 (anxiety L217: SSRI maxima for over-65s): ACCEPT, SAFETY CORRECTION. Over 65: citalopram up to 20 mg, escitalopram up to 10 mg a day (Medsafe data sheets).
- R3 (antenatal L221, abortion L85: iodine): ACCEPT. "150 micrograms of iodine a day (as potassium iodate)".
- R4 (IBD calprotectin unit): already sheet item 12; Codex supports micrograms per g.
- R5 (IBD L163: first surveillance colonoscopy at 10 years): ACCEPT. NZSG 2025 guidance linked by the raw: 8 years after diagnosis (consider symptom onset if diagnosis was delayed). Fix the matching answer fixture.
- R6 (abortion L38: sex-selection "prohibited"): ACCEPT. The Act states Parliament's opposition to abortion sought solely because of the baby's sex; it is not a ban.
- R7 (eczema L179, abortion L92: funding conditions): ACCEPT, remove (rule 4).
- R8 (AC5): DISPUTED, Brad's deferral.
