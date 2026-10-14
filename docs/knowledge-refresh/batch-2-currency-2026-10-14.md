# Batch 2: currency check against Medsafe data sheets (ruling 13, 2026-10-14)

Sonnet audit: ~/Documents/knowledge-refresh-recovery/runs/currency-batch-2.md (32 drugs, 15 handles). Orchestrator rulings:

| # | Handle | Difference | Ruling |
|---|---|---|---|
| C1 | cardiac-drugs-and-monitoring | Sotalol up to 640 mg a day; data sheet maximum 480 mg/day. | ACCEPT, SAFETY CORRECTION: "up to 480 mg a day, under specialist supervision". |
| C2 | cardiac-drugs-and-monitoring | Sotalol for AF up to 80 to 160 mg twice a day; data sheet for paroxysmal AF: 80 mg twice a day, up to 80 mg three times a day, not exceeded. | ACCEPT, SAFETY CORRECTION: data sheet dosing for paroxysmal AF; "a specialist may use more for persistent AF". |
| C3 | gout | Colchicine 0.5 mg again after 12 hours, then once or twice a day; data sheet: no more colchicine for 3 days after the 1.5 mg course. The entry also says "do not repeat within 3 days". | KEEP the NZ regimen (HealthPathways, bpacnz low-dose practice, off-label), FOR BRAD. Fix the contradiction: the 3-day gap applies to repeating the 1.5 mg starting course. |
| C4 | gout | Colchicine in kidney or liver impairment: data sheet contraindicates severe kidney or liver disease, and any impairment with P-gp or strong CYP3A4 inhibitors. | ACCEPT: add that colchicine is not used in severe kidney or liver disease, or with certain interacting medicines (for example clarithromycin); your doctor checks. |
| C5 | cardiac-drugs-and-monitoring | Clopidogrel stopped 5 days before surgery; data sheet 7. | ACCEPT softened: "usually stopped 5 to 7 days before planned surgery, as your doctor advises". |
| C6 | cardiac-drugs-and-monitoring | Omeprazole interaction "not supported by the evidence"; data sheet discourages omeprazole and esomeprazole. | ACCEPT: drop the reassurance; "your doctor may choose a different stomach-protection medicine, such as pantoprazole". |
| C7 | cardiac-drugs-and-monitoring | Ticagrelor: strong CYP3A4 inhibitors listed as a caution; data sheet contraindicates them, and prior intracranial haemorrhage. | ACCEPT. |
| C8 | cardiac-drugs-and-monitoring | Perhexiline: data sheet does not recommend it in any kidney or liver impairment; monthly liver tests. | ACCEPT. |
| C9 | cardiac-drugs-and-monitoring | Amiodarone: data sheet contraindicates thyroid dysfunction (current or past), pregnancy and breastfeeding. | ACCEPT. |
| C10 | cardiac-drugs-and-monitoring | SGLT2 inhibitors listed as a caution in pregnancy and breastfeeding; data sheets say not used. | ACCEPT: "not used in pregnancy or while breastfeeding". |
| C11 | hypothyroidism | Start 25 to 50 micrograms in older people or heart disease; data sheet 12.5 to 25 micrograms in heart disease, no more than 50 initially over 50 years. | ACCEPT. |
| C12 | direct-oral-anticoagulants | Rivaroxaban stopped below CrCl 30 in one place, 15 elsewhere; data sheet: not used below 15; AF dose 15 mg once daily at CrCl 15 to 49. | ACCEPT: make consistent with the data sheet. |

## Codex on the currency commit 6d4c3538 (gpt-6.1-sol, complete)
- R1 (gout: the reworded colchicine warning dropped the data sheet's severe kidney or liver contraindication): ACCEPT, restored: "The data sheet says colchicine must not be used in severe kidney or liver disease, or with certain interacting medicines (for example clarithromycin). With milder kidney problems the dose is lowered." The NZ prophylaxis line for eGFR 10 to 30 stays (HealthPathways) and joins Brad's colchicine decision (sheet item 15).
- R2 (data-sheet numbers rest on exceptions, not frozen evidence): ACCEPT. Data-sheet text frozen under knowledge-map-raw/refresh-2026-09-29/medsafe/ and registered in extra_raw with sha256; exceptions pruned where the checker now verifies.
- R3 (reports and batch report stale): ACCEPT. AC4 records added; batch report regenerated.
- R4 (no answer check for the changed cautions): ACCEPT. Two fixtures: colchicine in severe liver disease, amiodarone in pregnancy.
- R5 (commit messages lack US-42 and a deletion statement): ACCEPT from now on.
