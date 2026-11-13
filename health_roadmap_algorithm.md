# Health Roadmap Algorithm

Single source of truth for all health calculations, clinical thresholds, medication cascades, screening logic, and suggestion rules. The code in `packages/health-core/src/` implements this algorithm. Clinical evidence (patient-facing reasons, guideline citations, DOI references) for each suggestion is defined in `packages/health-core/src/evidence.ts` and attached automatically by `generateSuggestions()`. The user-facing `roadmap_text.html` must stay consistent with this document and `evidence.ts`.

`packages/health-core/src/metric-guides.ts` (`METRIC_GUIDES`, US-58) is display-only text, the "about this measure" guides in the iOS app: it may only restate thresholds and claims already in this document, `evidence.ts` and `roadmap_text.html`, plus standard prescribing facts Brad approved (side effects, how a drug works), the standard measuring and preparation tips he approved as a category on 2026-10-26, and the lines he restored that day (docs/drafts/metric-guides.md, "Brad's decisions (2026-10-26)"), and cites only `evidence.ts` references (its `GUIDE_REFERENCES` hold the roadmap_text.html citations no suggestion uses). A clinical change here that alters a guide's claim changes the guide too. Since 2026-10-31 it also holds guides for the four Apple Health metrics the app shows (`resting_heart_rate`, `sleep`, `vo2_max`, `steps`; US-56, US-58 AC7; `heart_rate` deleted 2026-11-06), with the claims Brad approved in docs/drafts/live-metric-guides.md. They set no target and change no plan: resting heart rate's risk link (Zhang 2016: about 9% higher risk of death per 10 bpm; Aune 2017; Reimers 2018 for exercise lowering it) and the step plateaus (Paluch 2022: about 6,000 to 8,000 a day from age 60, 8,000 to 10,000 younger) are display text, stated and cited in roadmap_text.html's Exercise section; sleep restates this document's 7-9 hours (Cappuccio 2010, with Watson 2015's AASM and SRS consensus as a second source). Apple's support pages, HealthKit documentation and white papers are cited only for how its devices measure, never for a clinical claim.

All values are stored and compared in **SI canonical units**. Conversion to display units (conventional/US) happens only at the UI layer.

---

## Table of Contents

1. [Health Calculations](#1-health-calculations)
2. [Unit Conversions](#2-unit-conversions)
3. [Clinical Thresholds](#3-clinical-thresholds)
4. [Suggestion Algorithm](#4-suggestion-algorithm)
5. [Cholesterol Medication Cascade](#5-cholesterol-medication-cascade)
6. [Weight & Diabetes Medication Cascade](#6-weight--diabetes-medication-cascade)
7. [Drug Configurations](#7-drug-configurations)
8. [Cancer Screening](#8-cancer-screening)
9. [Skin Health; Supplements (separate groups)](#9-skin-health-supplements-separate-groups)
10. [Progressive Disclosure](#10-progressive-disclosure)
11. [Reminder System](#11-reminder-system)
12. [Validation Ranges](#12-validation-ranges)
13. [FHIR Medication Storage](#13-fhir-medication-storage)

---

## 1. Health Calculations

Source: `calculations.ts`

### Ideal Body Weight (Peterson Formula, 2016)

`Ideal Body Weight = 2.2 × BMI_target + 3.5 × BMI_target × (height_m − 1.5)` kg

Sex-specific target BMIs (based on mortality meta-analyses):
- **Male:** BMI target = 24 (optimal mortality range 23–26)
- **Female:** BMI target = 22 (optimal mortality range 20–23)
- **Minimum:** `max(result, 30)` kg
- Rounded to 1 decimal place
- **No sex on record:** no ideal body weight. There is no unisex target BMI, so the plan never falls back to either one (US-07 AC8).

### Daily Protein Target

- **Normal:** `round(Ideal Body Weight * 1.2)` grams/day
- **CKD (eGFR < 45):** `round(Ideal Body Weight * 1.0)` grams/day

The CKD adjustment uses strict less-than: at exactly eGFR 45, the normal 1.2 multiplier applies.

The target is worked out from ideal body weight, so it needs sex too: with no sex on record there is no protein target (US-07 AC8).

### BMI

`weightKg / (heightCm / 100)^2` — rounded to 1 decimal place.

#### Composite Assessment (BMI + Waist-to-Height Ratio)

Per AACE 2025 and NICE guidelines, BMI classification in the 25–29.9 range is adjusted by waist-to-height ratio (WHtR) when available. WHtR is a superior universal screening tool that naturally accounts for body composition differences across populations.

| BMI Range | WHtR | Category | Rationale |
|-----------|------|----------|-----------|
| < 18.5 | any | Underweight | — |
| 18.5–24.9 | any | Normal | — |
| 25.0–29.9 | < 0.5 | Normal | No central adiposity — body composition is healthy |
| 25.0–29.9 | >= 0.5 | Overweight | Central adiposity confirmed |
| 25.0–29.9 | unknown | Overweight | The BMI tile shows no label; the plan prompts for a waist measurement, as it does at any BMI with no waist (section 4, Missing Measurements First) |
| 30.0–34.9 | any | Obese (Class I) | — |
| 35.0–39.9 | any | Obese (Class II) | — |
| >= 40.0 | any | Obese (Class III) | — |

**Key principle:** BMI 25–29.9 with normal WHtR (< 0.5) and no raised marker does NOT trigger weight management suggestions. A raised marker does, even with a healthy waist (see section 6).

### Waist-to-Height Ratio

`waistCm / heightCm` — rounded to 2 decimal places first, then graded: a rounded ratio >= 0.5 indicates increased metabolic risk. Because of the rounding, the ratio counts as elevated from about 0.495 × height (about 88.1 cm at 178 cm). Exactly on that line, floating-point rounding decides which side a waist falls. The plan and the vitals matrix grade the waist by this one rule (`isWaistToHeightElevated`). The matrix's "Target: <X" prints the first waist, at the display step, that the plan grades elevated (`formatTargetLine`): at 178 cm, 88 cm (0.494) is healthy and 89 cm (0.500) elevated, so "<89 cm". The matrix is editable, so a saved waist shows its plain value, coloured by the plan's grade (section 5): 88.1 cm at 178 cm is healthy, and shows as 34.7 in beside "<34.7 in", coloured healthy. When no waist is on record, a "Measure your waist circumference" suggestion is shown at any BMI, and with no weight yet (section 4, Missing Measurements First).

### Age

`currentYear - birthYear`, minus 1 if `currentMonth < birthMonth`. Minimum 0. Defaults to birthMonth = 1 if not provided.

### eGFR (CKD-EPI 2021, Race-Free)

Input: creatinine in umol/L. Internal conversion: `Cr_mg_dL = Cr_umol_L / 88.4`.

**Female:**
- kappa = 0.7
- alpha = -0.241 if Cr <= 0.7, else -1.200
- `eGFR = 142 * (Cr/0.7)^alpha * 0.9938^age * 1.012`

**Male:**
- kappa = 0.9
- alpha = -0.302 if Cr <= 0.9, else -1.200
- `eGFR = 142 * (Cr/0.9)^alpha * 0.9938^age`

Rounded to nearest integer (mL/min/1.73m^2).

**Age (US-07 AC7, Brad 2026-11-05):** the age on the creatinine's day, not today's, by the age rule in section 1 (a missing birth month is January): `ageOnDay(birthYear, birthMonth, day)`. A creatinine with no day yet (typed, not saved) uses today's age. **None from a creatinine taken by a known minor:** the equation is for adults, so a creatinine gives no calculated eGFR when the known-minor rule (section on adult readings, `isKnownMinor`) holds on the creatinine's day, even when the person is an adult today. That rule is judged on the test day exactly as it is judged today: with no birth month, a minor until 1 January of the year after they turn 18. A lab-printed eGFR still stands (below). The same rule judged today withholds every eGFR while the person is a known minor. The chat's server reads the day from `measurementHistory`, never a key of its own. An unsaved creatinine with a day (a blood-test draft) is sent as one more creatinine point marked `draft: true` (only that value marks one): the server takes that point's day when it holds the creatinine sent, then removes the point, so the model's history, `run_roadmap`'s "older than the saved value" check and every trend see saved points only. The client always sends the day of the creatinine in use: a creatinine typed with no day is sent as such a point dated the client's local today. Without such a point, or when it holds a different value, the day is the newest saved creatinine point's when it holds the value sent; else the plan uses today's age. `run_roadmap` weighs a lab eGFR against this same day, the day of the creatinine in use (any day after today counts as today there; a stated creatinine the run could not read, with a bad date or past the value cap, outdates the lab eGFR whatever its day). The server never guesses that day: with none to read, the lab eGFR stands. A lab eGFR it sets aside takes its printed limit (">90") with it. A creatinine stated in the chat uses its stated day (an undated one is today's), and it beats an unsaved draft, newer or not, because a draft is not saved (the older-than-saved check, US-15 AC33, is about saved points). In `run_roadmap`, a creatinine stated for a day the person was a known minor gives no calculated eGFR; with no lab eGFR, the standard protein card is kept and nothing is refused, as for a saved creatinine from such a day. A typed value goes as a draft dated today, so the chat reads it as today's, like the form.

**No sex on record:** no calculated eGFR. The equation has no unisex form, so the plan never falls back to either branch (US-07 AC8). A lab-printed eGFR still stands (below).

**Source (US-07 AC7, Brad 2026-10-27).** The plan reads one eGFR, chosen from two candidates by `withLabEgfr` (`plan.ts`):

- (a) the eGFR above, calculated from the latest active creatinine and dated by that row;
- (b) the latest active lab `egfr` row: the creatinine eGFR the lab printed, stored in mL/min/1.73m². `egfr_cystatin` and `egfr_combined` are never used.

The newer by measurement day wins. On the same day the lab's eGFR wins: the lab worked it out from a real serum creatinine, and ours may come from a misread row. Only one exists: that one. Candidate (a) exists only when the plan can calculate it: a known birth year, a known sex (US-07 AC8), no known minor on the creatinine's day (above) and a creatinine inside its input range (10–2650 µmol/L). Otherwise the lab eGFR stands, whatever the creatinine's day. Neither: no eGFR. A creatinine with no date (typed and not yet saved, or stated in the chat without a date) counts as today's, the day it would be saved with; an unsaved blood-test draft counts on the day it is dated. A creatinine is never worked back from an eGFR. The lab eGFR needs no age, and is rounded to the nearest integer. It drives the same rules as the calculated one: the CKD protein target, the potassium gate and the eGFR tile. One exception (US-07 AC8, orchestrator's call 2026-11-01, the cautious side): when a creatinine newer than the lab eGFR exists but the plan cannot calculate from it (no sex, no birth year, or taken by a known minor), the lab eGFR still shows and still sets the protein target, but it does not open the potassium advice (`labEgfrOutdated`). Potassium advice needs an eGFR that no newer creatinine has outdated. A known minor's eGFR is withheld either way (section on adult readings). With a lab eGFR, creatinine is not a missing plan input.

### Non-HDL Cholesterol

`totalCholesterol - HDL` (mmol/L), kept to 4 decimal places only to strip float noise (3.80 − 2.20 is 1.5999… in floating point). Every threshold compares it unrounded; it is rounded only for display (1 decimal place in mmol/L, whole mg/dL). So 1.56 is below the 1.6 target, and 190 mg/dL reaches the 190 mg/dL line. Beside its target (section 5), 1.56 shows as 1.56, not 1.6: see `formatGradedValue` there. BMI and waist-to-height, which are unitless, keep their rounded rule.

---

## 2. Unit Conversions

Source: `units.ts`

### Conversion Constants

| Constant | Value |
|----------|-------|
| LBS_PER_KG | 2.20462 |
| CM_PER_INCH | 2.54 |
| INCHES_PER_FOOT | 12 |
| CHOLESTEROL_FACTOR | 38.67 (mmol/L to mg/dL for LDL, HDL, total cholesterol) |
| TRIGLYCERIDES_FACTOR | 88.57 (mmol/L to mg/dL) |
| APOB_FACTOR | 100 (g/L to mg/dL) |
| CREATININE_FACTOR | 88.4 (umol/L to mg/dL, divide) |

### HbA1c Conversion (NGSP % <-> IFCC mmol/mol)

- **NGSP to IFCC:** `(NGSP - 2.152) / 0.09148`
- **IFCC to NGSP:** `0.09148 * IFCC + 2.152`

| NGSP % | IFCC mmol/mol |
|--------|---------------|
| 5.7% | ~38.8 |
| 6.5% | ~47.5 |

### Canonical (Storage) Units

| Metric | Canonical | Conventional Display | Conversion |
|--------|-----------|---------------------|------------|
| height | cm | inches | / 2.54 |
| weight | kg | lbs | * 2.20462 |
| waist | cm | inches | / 2.54 |
| hba1c | mmol/mol (IFCC) | % (NGSP) | formula above |
| ldl | mmol/L | mg/dL | * 38.67 |
| hdl | mmol/L | mg/dL | * 38.67 |
| total_cholesterol | mmol/L | mg/dL | * 38.67 |
| triglycerides | mmol/L | mg/dL | * 88.57 |
| apob | g/L | mg/dL | * 100 |
| creatinine | umol/L | mg/dL | / 88.4 |
| systolic_bp | mmHg | mmHg | (same) |
| diastolic_bp | mmHg | mmHg | (same) |
| psa | ng/mL | ng/mL | (same) |
| lpa | nmol/L | mg/dL | / 2.5 (nmol/L ≈ 2.5 × mg/dL; approximate, see Lp(a) below) |

### Height Display (Conventional)

`cm / 2.54 = totalInches`, then `feet = floor(totalInches / 12)`, `inches = round(totalInches % 12)`. If rounded inches >= 12, carry to next foot. Display: `5'10"`.

### Decimal Places

| Metric | SI | Conventional |
|--------|----|----|
| height | 0 | 1 |
| weight | 1 | 0 |
| waist | 0 | 1 |
| hba1c | 0 | 1 |
| ldl, hdl, total_cholesterol | 1 | 0 |
| triglycerides | 1 | 0 |
| apob | 2 | 0 |
| creatinine | 0 | 2 |
| psa | 1 | 1 |
| lpa | 0 | 1 (mg/dL; mg/L, a tenth of it, at 0) |

An additional lab test (one this table does not list) shows its stored value to up to two decimal places with no trailing zeros. Below 0.1 it keeps two significant figures instead, so a suppressed TSH of 0.004 mIU/L shows as 0.004, not 0, and 0.0456 as 0.046 (`formatLabValue`, US-21 AC25, Brad 2026-11-04). A value printed as a limit shows as printed ("< 0.005"). Display only: the stored number is unchanged.

### Lab catalogue conversions

Source: `packages/health-core/src/lab-catalog.ts` (`LAB_CONVERSIONS`, `canonicalLabValue`). Since US-21 phase 3, a lab test the catalogue knows is **stored** in its canonical SI unit, not in the unit the lab printed. A writer sends the number and the unit as printed; the record converts it once, on the write, and converts `referenceLow`/`referenceHigh` by the same factor.

Factor = the number a reported value is multiplied by to reach the canonical unit. Spellings are matched lower case, after `normalizeLabUnit` folds report and LLM spelling (`umol/L` → `µmol/L`, `mcg` → `µg`, `uL` → `µL`, `x 10e9/L` → `×10⁹/L`, `1.73m2` → `1.73m²`, `gm/dL` → `g/dL`, `Units/L` → `U/L`, `10^3/cmm`, `10^3/cumm`, `10^3/mm3` or `10^3/mm³` → `×10³/µL`, `10^6/mm3` or `10^6/mm³` → `×10⁶/µL`, `cells/uL`, `cells/cmm`, `cells/cumm`, `cells/mm3` or `cells/mm³` → `cells/µL`; a bracketed or superscript power of ten, `x10(3)/uL`, `10^(9)/L`, `x10³/µL` or `10³/µL` → `×10³/µL` or `×10⁹/L`, and `mcL` → `µL`, so `K/mcL` → `K/µL`; `dL`, `mL` and `µL` in any case, as a whole token, so `mg/dl` → `mg/dL`, while `G/L`, giga per litre, stays apart from `g/L`). A cubic millimetre is a microlitre, so these folds rescale nothing. `mm3` and `mm³` fold only after a slash: a bare `mm³` is a volume and is never folded. A factor of 1 is a different notation for the same scale, not a conversion.

A spelling this table does not carry for that test is **refused** — never rescaled by guess. The refusal names the canonical unit and every spelling the test accepts, and the website counts it as `lab_unit_refused`. Six things follow from that:

- **A count in cells/µL converts only as a whole number** (WBC, the five differentials, platelets). Cells are counted, so a decimal in the result or either reference bound, or (with both bounds printed) a result above a hundred times the high bound or, for WBC and platelets only, below a hundredth of the low bound, means the lab printed thousands under the wrong label: the row is refused, never rescaled. A decimal's refusal asks whether the report means ×10³/µL; a range mismatch's says the value and its printed range are on different scales. A result of 0 always passes (it reads the same on any scale), and the differentials get no low-side check because real counts sit near zero. A correction in cells/µL is checked the same way against the range the row already holds, read on the canonical scale (so a legacy row still stored as `K/uL` or `10^3/cmm` is checked too). No per-test minimum yet, so a mislabelled whole number can still land.
- **A value no human sample reaches is refused** (US-21 AC21, Brad 2026-10-20). A real sheet printed free testosterone as "nmol/L" when its number and range (163–473) were pmol/L, so the ×1000 conversion produced an impossible result that would have saved. The count check cannot catch this, because the value and its range are mislabelled together. Five tests reachable through a ×1000 upward conversion carry a ceiling in their canonical unit: `free_testosterone` 10,000 pmol/L, `free_testosterone_calculated` 10,000 pmol/L, `reverse_t3` 10,000 pmol/L, `c_peptide` 50,000 pmol/L, `reticulocytes` 2,000 ×10⁹/L. The check applies only to a row converted by a ×1000 prefix step (nmol/L to pmol/L, ×10¹²/L to ×10⁹/L): when its converted value, or its converted printed high bound, passes the ceiling, it is refused, never rescaled. A row printed in any other spelling (the canonical unit, pg/mL, ng/dL, ng/mL) is never refused by the ceiling, because a real result can pass it (free testosterone on heavy androgen use can exceed 10,000 pmol/L, printed as pmol/L or as pg/mL). Without a printed range, a prefix error that lands under the ceiling is not caught (a female free testosterone of 8 printed as nmol/L stores 8,000 pmol/L). The refusal's note names the test, the ceiling and the two units, never the number: "Free testosterone above 10,000 pmol/L is not a measured value, so the printed unit is probably wrong (nmol/L vs pmol/L). Check the report, then add it in pmol/L with + Add a blood test." Troponin has no ceiling: a real high troponin overlaps a mislabelled one. Load never deletes or rewrites a row, so a stored row above a ceiling is left as it is: a legacy printed row gets no `#si` child, and one an older build already converted stays.
- **A value past its plausible range is refused** (US-21 AC26, 2026-11-06; every bound approved by Brad the same day; on every door since 2026-11-09). A break-test typed glucose 5.5, picked mg/dL, and saved 0.31 mmol/L. These are typing-mistake limits, in the canonical unit after conversion, that no real result passes; they are not reference ranges, grade nothing and change no suggestion. Every way a value enters is checked: typed adds and corrections, assistants and the command line (refused, nothing written), uploads (the row is not saved and the summary names the limit it passed) and Health Records (the result is skipped and counted as not read). Source: `LAB_PLAUSIBLE_RANGES` in `lab-catalog.ts`, each bound with its basis there. A min of 0 refuses only a negative value and otherwise checks the top end.

  | key | canonical | min | max |
  |-----|-----------|-----|-----|
  | `glucose`, `glucose_random` | mmol/L | 0.5 (Brad 2026-11-06: "people would be dead at 0.5 mmol/L") | 150 |
  | `sodium` | mmol/L | 70 | 260 |
  | `potassium` | mmol/L | 0.5 | 20 |
  | `urate` | mmol/L | 0 | 6 |
  | `alt`, `ast` | U/L | 0 | 50,000 |
  | `albumin` | g/L | 0 | 80 |
  | `haemoglobin` | g/L | 5 | 300 |
  | `wbc` | ×10⁹/L | 0 | 2,000 |
  | `platelets` | ×10⁹/L | 0 | 10,000 |
  | `tsh` | mIU/L | 0 | 2,000 |
  | `ft4` | pmol/L | 0 | 200 |
  | `crp` | mg/L | 0 | 1,000 |
  | `vitamin_d` | nmol/L | 0 | 2,500 |
  | `vitamin_b12` | pmol/L | 0 | 20,000 |
  | `folate` | nmol/L | 0 | 1,000 |
  | `ferritin` | µg/L | 0 | 500,000 |
  | `iron` | µmol/L | 0 | 1,000 |

  Checked where a person or agent types one value: `addLabValue` (the web's "+ Add a blood test" and "+ Add a value", the iPhone's add by name and a test's own "+") and `correctValue`'s lab branch (the web's value page and matrix correction, the iPhone's correct edit, MCP `correct_value`, the CLI's `correct`). Every one of these doors shows the refusal in the engine's words. The refusal names the number as typed and what it converted to when the typed unit is not the canonical one, then the end passed, each as the matrix prints it with thousands separators: "5.5 mg/dL is 0.31 mmol/L. Glucose below 0.5 mmol/L is almost certainly a typing or unit mistake: check the number and its unit." A row already stored past a bound is never touched and still shows.
- **A differential in % is refused.** It is a share of the white count, not a count, and is never multiplied out from the WBC. Its refusal says the record keeps the absolute count (×10⁹/L or cells/µL), so the person looks for that line on the same report.
- **Prolactin in ng/mL is refused on purpose.** The mIU/L factor is assay-dependent (about 21.2 for the WHO 3rd IS), so converting would invent precision the report does not have.
- **A test the catalogue does not know is stored exactly as reported**, with its printed unit. There is no SI definition to convert it to, and refusing it would throw the value away. Its units are compared after the folds above, so `mg/dL` and `mg/dl` are one unit and chart as one line (US-21 AC14, Brad 2026-11-04).
- **Rows written before phase 3 are corrected at load**, not edited: `migrate.ts` appends a converted row with the id `<id>#si` and `correctsId` set, and flips the printed row to `entered-in-error`. Same id on every device, so cross-device copies merge into one row. A legacy `gm/dL` row (haemoglobin, albumin, total protein, globulin, MCHC) now converts at ×10 on load through the same path. So does a legacy whole count in cells/µL, at ×0.001; a decimal one is left as it is.

| key | canonical | reported spelling | × factor | note |
|-----|-----------|-------------------|----------|------|
| `sodium` | mmol/L | meq/l | 1 | mEq/L and mmol/L are the same number for a singly charged ion |
| `potassium` | mmol/L | meq/l | 1 | mEq/L and mmol/L are the same number for a singly charged ion |
| `chloride` | mmol/L | meq/l | 1 | mEq/L and mmol/L are the same number for a singly charged ion |
| `bicarbonate` | mmol/L | meq/l | 1 | mEq/L and mmol/L are the same number for a singly charged ion |
| `urea` | mmol/L | mg/dl (printed name: bun / blood urea nitrogen / urea nitrogen) | 0.357 | urea nitrogen, the molecule’s 2 N, 28.014 g/mol. mg/dL reaches this slot ONLY under a nitrogen name: under the bare name "urea" it is ambiguous (US nitrogen vs the whole molecule), so it is refused. "Urea Nitrogen (BUN)" and "Blood Urea Nitrogen (BUN)" take it too, as nitrogen names; "Urea (BUN)" does not say which, so it is refused there (US-21 AC20) |
| `urate` | mmol/L | mg/dl | 0.05948 | urate 168.11 g/mol |
| `urate` | mmol/L | µmol/l | 0.001 | a micromole is a thousandth of a millimole (UK labs print µmol/L) |
| `urine_acr` | mg/mmol | mg/g | 0.113 | creatinine 113.12 g/mol, so 1 g ≡ 8.840 mmol |
| `urine_acr` | mg/mmol | mg/g creat | 0.113 | mg/g with the creatinine named |
| `urine_acr` | mg/mmol | mg/g creatinine | 0.113 | mg/g with the creatinine named |
| `urine_creatinine` | mmol/L | mg/dl | 0.0884 | creatinine 113.12 g/mol |
| `urine_creatinine` | mmol/L | µmol/l | 0.001 | a micromole is a thousandth of a millimole |
| `urine_pcr` | mg/mmol | mg/g | 0.113 | creatinine 113.12 g/mol, so 1 g ≡ 8.840 mmol (as `urine_acr`) |
| `urine_pcr` | mg/mmol | mg/g creat | 0.113 | mg/g with the creatinine named |
| `urine_pcr` | mg/mmol | mg/g creatinine | 0.113 | mg/g with the creatinine named |
| `urine_pcr` | mg/mmol | mg/mg | 113.12 | mg protein per mg creatinine; creatinine 113.12 g/mol, so 1 mg ≡ 1/113.12 mmol |
| `egfr` | mL/min/1.73m² | ml/min/1.73 m² | 1 | spacing only |
| `egfr` | mL/min/1.73m² | ml/min/1.73 | 1 | the body-surface area left unwritten (LabCorp) |
| `egfr_cystatin` | mL/min/1.73m² | ml/min/1.73 m² | 1 | spacing only |
| `egfr_cystatin` | mL/min/1.73m² | ml/min/1.73 | 1 | the body-surface area left unwritten (LabCorp) |
| `egfr_combined` | mL/min/1.73m² | ml/min/1.73 m² | 1 | spacing only |
| `egfr_combined` | mL/min/1.73m² | ml/min/1.73 | 1 | the body-surface area left unwritten (LabCorp) |
| `anion_gap` | mmol/L | meq/l | 1 | mEq/L and mmol/L are the same number for a singly charged ion |
| `osmolality_serum` | mOsm/kg | mmol/kg | 1 | labs print osmolality in mmol/kg as the same number |
| `osmolality_serum` | mOsm/kg | mosmol/kg | 1 | mOsm/kg spelled out |
| `alt` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `ast` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `ggt` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `alp` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `bilirubin_total` | µmol/L | mg/dl | 17.1 | bilirubin 584.66 g/mol |
| `bilirubin_direct` | µmol/L | mg/dl | 17.1 | bilirubin 584.66 g/mol |
| `ldh` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `albumin` | g/L | g/dl | 10 | a decilitre is a tenth of a litre |
| `total_protein` | g/L | g/dl | 10 | a decilitre is a tenth of a litre |
| `globulin` | g/L | g/dl | 10 | a decilitre is a tenth of a litre |
| `bilirubin_indirect` | µmol/L | mg/dl | 17.1 | bilirubin 584.66 g/mol |
| `lipase` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `amylase` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `haemoglobin` | g/L | g/dl | 10 | a decilitre is a tenth of a litre |
| `haemoglobin` | g/L | mmol/l | 16.11 | haemoglobin per haem, 16.11 g/mol (Dutch convention) |
| `haematocrit` | L/L | ratio | 1 | a ratio IS L/L |
| `haematocrit` | L/L | fraction | 1 | a fraction IS L/L |
| `haematocrit` | L/L | % | 0.01 | a percentage is a hundredth |
| `rbc` | ×10¹²/L | ×10⁶/µl | 1 | an analyser’s spelling of ×10¹²/L |
| `rbc` | ×10¹²/L | m/µl | 1 | an analyser’s spelling of ×10¹²/L |
| `rbc` | ×10¹²/L | million/µl | 1 | an analyser’s spelling of ×10¹²/L |
| `rbc` | ×10¹²/L | t/l | 1 | an analyser’s spelling of ×10¹²/L |
| `wbc` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `wbc` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `wbc` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `wbc` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `wbc` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `wbc` | ×10⁹/L | cells/µl | 0.001 | a microlitre is 10⁻⁶ L, so 2400 cells/µL is 2.4 ×10⁹/L. Whole numbers only: a decimal is refused |
| `platelets` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | cells/µl | 0.001 | a microlitre is 10⁻⁶ L, so 2400 cells/µL is 2.4 ×10⁹/L. Whole numbers only: a decimal is refused |
| `neutrophils` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | cells/µl | 0.001 | a microlitre is 10⁻⁶ L, so 2400 cells/µL is 2.4 ×10⁹/L. Whole numbers only: a decimal is refused |
| `lymphocytes` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | cells/µl | 0.001 | a microlitre is 10⁻⁶ L, so 2400 cells/µL is 2.4 ×10⁹/L. Whole numbers only: a decimal is refused |
| `monocytes` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | cells/µl | 0.001 | a microlitre is 10⁻⁶ L, so 2400 cells/µL is 2.4 ×10⁹/L. Whole numbers only: a decimal is refused |
| `eosinophils` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | cells/µl | 0.001 | a microlitre is 10⁻⁶ L, so 2400 cells/µL is 2.4 ×10⁹/L. Whole numbers only: a decimal is refused |
| `basophils` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | cells/µl | 0.001 | a microlitre is 10⁻⁶ L, so 2400 cells/µL is 2.4 ×10⁹/L. Whole numbers only: a decimal is refused |
| `mchc` | g/L | g/dl | 10 | a decilitre is a tenth of a litre |
| `immature_granulocytes` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `immature_granulocytes` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `immature_granulocytes` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `immature_granulocytes` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `immature_granulocytes` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `immature_granulocytes` | ×10⁹/L | cells/µl | 0.001 | a microlitre is 10⁻⁶ L. Whole numbers only: a decimal is refused |
| `reticulocytes` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `reticulocytes` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `reticulocytes` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `reticulocytes` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `reticulocytes` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `reticulocytes` | ×10⁹/L | ×10¹²/l | 1000 | 10¹² is a thousand 10⁹. A reticulocyte % is refused |
| `nrbc` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `nrbc` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `nrbc` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `nrbc` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `nrbc` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `d_dimer` | mg/L FEU | mg/l (feu) | 1 | spelling only. Every D-dimer spelling must say FEU: a bare ng/mL is often DDU, about half the FEU number, so it is refused |
| `d_dimer` | mg/L FEU | µg/ml feu | 1 | µg/mL is mg/L |
| `d_dimer` | mg/L FEU | µg/ml (feu) | 1 | µg/mL is mg/L |
| `d_dimer` | mg/L FEU | ng/ml feu | 0.001 | ng/mL is µg/L, a thousandth of mg/L |
| `d_dimer` | mg/L FEU | ng/ml (feu) | 0.001 | ng/mL is µg/L, a thousandth of mg/L |
| `d_dimer` | mg/L FEU | µg/l feu | 0.001 | a microgram is a thousandth of a milligram |
| `d_dimer` | mg/L FEU | µg/l (feu) | 0.001 | a microgram is a thousandth of a milligram |
| `fibrinogen` | g/L | mg/dl | 0.01 | a milligram per decilitre is a hundredth of a gram per litre |
| `tsh` | mIU/L | µiu/ml | 1 | µIU/mL and mIU/L are the same number |
| `tsh` | mIU/L | mu/l | 1 | mU/L is mIU/L, printed short |
| `tsh` | mIU/L | µu/ml | 1 | µU/mL is µIU/mL, printed short |
| `tsh` | mIU/L | microiu/ml | 1 | µIU/mL with the prefix spelled out |
| `tsh` | mIU/L | mciu/ml | 1 | µIU/mL with the mc prefix (as mcg) |
| `ft4` | pmol/L | ng/dl | 12.87 | thyroxine 776.87 g/mol |
| `ft3` | pmol/L | pg/ml | 1.536 | triiodothyronine 650.97 g/mol |
| `anti_tpo` | IU/mL | kiu/l | 1 | kIU/L and IU/mL are the same number |
| `anti_tpo` | IU/mL | u/ml | 1 | U/mL is IU/mL, printed short |
| `total_t4` | nmol/L | µg/dl | 12.87 | thyroxine 776.87 g/mol |
| `total_t3` | nmol/L | ng/dl | 0.01536 | triiodothyronine 650.97 g/mol |
| `total_t3` | nmol/L | ng/ml | 1.536 | triiodothyronine 650.97 g/mol |
| `total_t3` | nmol/L | µg/l | 1.536 | triiodothyronine 650.97 g/mol (µg/L is the ng/mL number) |
| `reverse_t3` | pmol/L | pg/ml | 1.536 | reverse T3 650.97 g/mol, as T3 |
| `reverse_t3` | pmol/L | ng/dl | 15.36 | reverse T3 650.97 g/mol, as T3 |
| `reverse_t3` | pmol/L | nmol/l | 1000 | a nanomole is a thousand picomoles |
| `thyroglobulin` | µg/L | ng/ml | 1 | ng/mL and µg/L are the same number |
| `anti_tg` | IU/mL | kiu/l | 1 | kIU/L and IU/mL are the same number |
| `testosterone_total` | nmol/L | ng/dl | 0.0347 | testosterone 288.42 g/mol |
| `testosterone_total` | nmol/L | ng/ml | 3.467 | testosterone 288.42 g/mol |
| `free_testosterone` | pmol/L | pg/ml | 3.467 | testosterone 288.42 g/mol |
| `free_testosterone` | pmol/L | ng/dl | 34.67 | testosterone 288.42 g/mol |
| `free_testosterone` | pmol/L | nmol/l | 1000 | a nanomole is a thousand picomoles |
| `free_testosterone_calculated` | pmol/L | pg/ml | 3.467 | testosterone 288.42 g/mol (a calculated free testosterone: a test of its own, same factors) |
| `free_testosterone_calculated` | pmol/L | ng/dl | 34.67 | testosterone 288.42 g/mol |
| `free_testosterone_calculated` | pmol/L | nmol/l | 1000 | a nanomole is a thousand picomoles |
| `estradiol` | pmol/L | pg/ml | 3.671 | estradiol 272.38 g/mol |
| `estradiol` | pmol/L | ng/l | 3.671 | estradiol 272.38 g/mol |
| `prolactin` | mIU/L | µiu/ml | 1 | µIU/mL and mIU/L are the same number (ng/mL stays refused: assay-dependent) |
| `prolactin` | mIU/L | mu/l | 1 | mU/L is mIU/L, printed short |
| `prolactin` | mIU/L | µu/ml | 1 | µU/mL is µIU/mL, printed short |
| `prolactin` | mIU/L | microiu/ml | 1 | µIU/mL with the prefix spelled out |
| `prolactin` | mIU/L | mciu/ml | 1 | µIU/mL with the mc prefix (as mcg) |
| `cortisol_am` | nmol/L | µg/dl | 27.59 | cortisol 362.46 g/mol |
| `cortisol_random` | nmol/L | µg/dl | 27.59 | cortisol 362.46 g/mol |
| `cortisol_pm` | nmol/L | µg/dl | 27.59 | cortisol 362.46 g/mol |
| `psa_free` | µg/L | ng/ml | 1 | ng/mL and µg/L are the same number |
| `lh` | IU/L | miu/ml | 1 | mIU/mL and IU/L are the same number |
| `lh` | IU/L | mu/ml | 1 | mU/mL is mIU/mL, printed short |
| `lh` | IU/L | u/l | 1 | U/L is IU/L, printed short |
| `fsh` | IU/L | miu/ml | 1 | mIU/mL and IU/L are the same number |
| `fsh` | IU/L | mu/ml | 1 | mU/mL is mIU/mL, printed short |
| `fsh` | IU/L | u/l | 1 | U/L is IU/L, printed short |
| `progesterone` | nmol/L | ng/ml | 3.180 | progesterone 314.46 g/mol |
| `dhea_s` | µmol/L | µg/dl | 0.02714 | DHEA sulfate 368.49 g/mol |
| `igf1` | nmol/L | ng/ml | 0.1307 | IGF-1 7649 g/mol |
| `igf1` | nmol/L | µg/l | 0.1307 | µg/L is the ng/mL number |
| `pth` | pmol/L | pg/ml | 0.1061 | PTH 1-84 9424.7 g/mol (UniProt P01270) |
| `pth` | pmol/L | ng/l | 0.1061 | PTH 1-84 9424.7 g/mol (UniProt P01270) |
| `amh` | pmol/L | ng/ml | 7.14 | the 140 kDa dimer convention, as insulin’s 6.00 is one |
| `bioavailable_testosterone` | nmol/L | ng/dl | 0.0347 | testosterone 288.42 g/mol |
| `estrone` | pmol/L | pg/ml | 3.699 | estrone 270.37 g/mol |
| `androstenedione` | nmol/L | ng/dl | 0.03492 | androstenedione 286.41 g/mol |
| `androstenedione` | nmol/L | ng/ml | 3.492 | androstenedione 286.41 g/mol |
| `oh_progesterone_17` | nmol/L | ng/dl | 0.03026 | 17-hydroxyprogesterone 330.46 g/mol |
| `oh_progesterone_17` | nmol/L | ng/ml | 3.026 | 17-hydroxyprogesterone 330.46 g/mol |
| `dht` | nmol/L | ng/dl | 0.03443 | dihydrotestosterone 290.44 g/mol |
| `dht` | nmol/L | pg/ml | 0.003443 | dihydrotestosterone 290.44 g/mol |
| `acth` | pmol/L | pg/ml | 0.2202 | ACTH 1-39 4541 g/mol |
| `acth` | pmol/L | ng/l | 0.2202 | ACTH 1-39 4541 g/mol |
| `gh` | µg/L | ng/ml | 1 | ng/mL and µg/L are the same number |
| `hcg` | IU/L | miu/ml | 1 | mIU/mL and IU/L are the same number |
| `hcg` | IU/L | mu/ml | 1 | mU/mL is mIU/mL, printed short |
| `vitamin_d` | nmol/L | ng/ml | 2.496 | 25-OH-D 400.64 g/mol |
| `vitamin_d` | nmol/L | µg/l | 2.496 | 25-OH-D 400.64 g/mol |
| `vitamin_b12` | pmol/L | pg/ml | 0.738 | cyanocobalamin 1355.4 g/mol |
| `vitamin_b12` | pmol/L | ng/l | 0.738 | cyanocobalamin 1355.4 g/mol |
| `folate` | nmol/L | ng/ml | 2.266 | folate 441.4 g/mol |
| `folate` | nmol/L | µg/l | 2.266 | folate 441.4 g/mol |
| `ferritin` | µg/L | ng/ml | 1 | ng/mL and µg/L are the same number |
| `iron` | µmol/L | µg/dl | 0.179 | iron 55.845 g/mol |
| `tibc` | µmol/L | µg/dl | 0.179 | iron 55.845 g/mol |
| `transferrin` | g/L | mg/dl | 0.01 | a milligram per decilitre is a hundredth of a gram per litre |
| `magnesium` | mmol/L | mg/dl | 0.4114 | magnesium 24.305 g/mol |
| `magnesium` | mmol/L | meq/l | 0.5 | Mg²⁺ carries two charges |
| `calcium_corrected` | mmol/L | mg/dl | 0.2495 | calcium 40.078 g/mol |
| `calcium_total` | mmol/L | mg/dl | 0.2495 | calcium 40.078 g/mol |
| `phosphate` | mmol/L | mg/dl | 0.3229 | phosphorus 30.97 g/mol |
| `zinc` | µmol/L | µg/dl | 0.153 | zinc 65.38 g/mol |
| `red_cell_folate` | nmol/L | ng/ml | 2.266 | folate 441.4 g/mol |
| `red_cell_folate` | nmol/L | µg/l | 2.266 | folate 441.4 g/mol |
| `calcium_ionised` | mmol/L | mg/dl | 0.2495 | calcium 40.078 g/mol |
| `calcium_ionised` | mmol/L | meq/l | 0.5 | Ca²⁺ carries two charges |
| `uibc` | µmol/L | µg/dl | 0.179 | iron 55.845 g/mol |
| `copper` | µmol/L | µg/dl | 0.1574 | copper 63.546 g/mol |
| `caeruloplasmin` | g/L | mg/dl | 0.01 | a milligram per decilitre is a hundredth of a gram per litre |
| `selenium` | µmol/L | µg/l | 0.01266 | selenium 78.971 g/mol |
| `selenium` | µmol/L | ng/ml | 0.01266 | selenium 78.971 g/mol |
| `vitamin_a` | µmol/L | µg/dl | 0.03491 | retinol 286.45 g/mol |
| `vitamin_e` | µmol/L | mg/l | 2.322 | alpha-tocopherol 430.71 g/mol |
| `vitamin_e` | µmol/L | mg/dl | 23.22 | alpha-tocopherol 430.71 g/mol |
| `vitamin_c` | µmol/L | mg/dl | 56.78 | ascorbic acid 176.12 g/mol |
| `vitamin_b6` | nmol/L | ng/ml | 4.046 | pyridoxal 5′-phosphate 247.14 g/mol |
| `vitamin_b6` | nmol/L | µg/l | 4.046 | pyridoxal 5′-phosphate 247.14 g/mol |
| `mma` | µmol/L | nmol/l | 0.001 | a nanomole is a thousandth of a micromole |
| `crp` | mg/L | mg/dl | 10 | a decilitre is a tenth of a litre |
| `esr` | mm/hr | mm/h | 1 | spelling only |
| `procalcitonin` | µg/L | ng/ml | 1 | ng/mL and µg/L are the same number |
| `ige` | kU/L | iu/ml | 1 | a kU/L of IgE is an IU/mL |
| `ige` | kU/L | kiu/l | 1 | kIU/L is kU/L |
| `rf` | IU/mL | kiu/l | 1 | kIU/L and IU/mL are the same number |
| `total_iga` | g/L | mg/dl | 0.01 | a milligram per decilitre is a hundredth of a gram per litre |
| `glucose` | mmol/L | mg/dl | 0.05551 | glucose 180.16 g/mol |
| `glucose_random` | mmol/L | mg/dl | 0.05551 | glucose 180.16 g/mol (a random glucose: a test of its own, not a fasting one) |
| `insulin` | mIU/L | µiu/ml | 1 | µIU/mL and mIU/L are the same number |
| `insulin` | mIU/L | mu/l | 1 | mU/L is mIU/L, printed short |
| `insulin` | mIU/L | µu/ml | 1 | µU/mL is µIU/mL, printed short |
| `insulin` | mIU/L | microiu/ml | 1 | µIU/mL with the prefix spelled out |
| `insulin` | mIU/L | mciu/ml | 1 | µIU/mL with the mc prefix (as mcg) |
| `insulin` | mIU/L | pmol/l | 0.1667 | 1 µIU/mL = 6.00 pmol/L, the insulin-standardisation convention |
| `apoa1` | g/L | mg/dl | 0.01 | a milligram per decilitre is a hundredth of a gram per litre |
| `ck` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `nt_probnp` | ng/L | pg/ml | 1 | pg/mL and ng/L are the same number |
| `bnp` | ng/L | pg/ml | 1 | pg/mL and ng/L are the same number |
| `troponin_t` | ng/L | pg/ml | 1 | pg/mL and ng/L are the same number |
| `troponin_t` | ng/L | µg/l | 1000 | a microgram is a thousand nanograms |
| `troponin_t` | ng/L | ng/ml | 1000 | a microgram is a thousand nanograms (ng/mL is µg/L) |
| `troponin_i` | ng/L | pg/ml | 1 | pg/mL and ng/L are the same number |
| `troponin_i` | ng/L | µg/l | 1000 | a microgram is a thousand nanograms |
| `troponin_i` | ng/L | ng/ml | 1000 | a microgram is a thousand nanograms (ng/mL is µg/L) |
| `c_peptide` | pmol/L | ng/ml | 331.1 | C-peptide 3020.3 g/mol |
| `c_peptide` | pmol/L | µg/l | 331.1 | C-peptide 3020.3 g/mol (µg/L is the ng/mL number) |
| `c_peptide` | pmol/L | nmol/l | 1000 | a nanomole is a thousand picomoles |
| `eag` | mmol/L | mg/dl | 0.05551 | glucose 180.16 g/mol (an estimated average glucose, from HbA1c) |
| `vldl` | mmol/L | mg/dl | 0.02586 | cholesterol 386.65 g/mol |
| `lactate` | mmol/L | mg/dl | 0.111 | lactic acid 90.08 g/mol |

A plain "calcium" is total calcium (`calcium_total`), never corrected calcium (US-21 AC12, fixed 2026-10-18; it used to land on `calcium_corrected`). Rows already stored under the key `calcium_corrected` stay there: no migration. A row stored as a plain calcium (the website upload's snake_case `calcium`, or the assistant's printed "Calcium") now reads as total calcium.

Nineteen catalogued tests take only their canonical unit, so they have no row above: `cystatin_c` (mg/L), `mcv` (fL), `mch` (pg), `rdw` (%), `rdw_sd` (fL), `mpv` (fL), `t3_uptake` (%), `trab` (IU/L), `shbg` (nmol/L), `psa_free_percent` (%), `b12_active` (pmol/L), `transferrin_sat` (%), `stfr` (mg/L), `omega3_index` (%), `vitamin_b1` (nmol/L), `anti_ccp` (U/mL), `ttg_iga` (U/mL), `homocysteine` (µmol/L) and `fructosamine` (µmol/L). Any other spelling is refused. (Until 2026-10-20 this sentence named three; five more already took only their canonical unit.)

Non-HDL cholesterol is deliberately not catalogued. The app derives it from total cholesterol and HDL, so a stored lab row would duplicate it; a printed one is kept as an uncatalogued row with its printed unit.

**Tests added 2026-10-20 (US-21 AC19, AC20; Brad approved the 2026-10-19 catalogue audit with its reviewer's corrections).** 61 tests joined the catalogue, each stored in its SI unit through the rows above. Every factor is one molar mass, rechecked against PubChem (UniProt P01270 for PTH 1-84, 9424.7 g/mol). The rule for a derived value stays "the app derives it": indirect bilirubin, anion gap, eAG and VLDL are catalogued because the app derives none of them. Tests of their own, never one slot with their neighbours: red cell folate (serum folate), ionised calcium (total and corrected calcium), RDW-SD (RDW, which is RDW-CV in %), total and reverse T3 and total T4 (the free ones), eGFR from cystatin C or from both markers (the creatinine eGFR), troponin T and I, BNP and NT-proBNP, bioavailable and free testosterone, % free PSA and free PSA. Refused on purpose:

- **D-dimer** converts only from a spelling that says FEU. A bare ng/mL is often D-dimer units (DDU), about half the FEU number.
- **NT-proBNP and BNP in pmol/L, and TRAb in U/L**, are refused. Older non-WHO TRAb assays print U/L that are not IU/L.
- **Osmolality** resolves only under a serum or plasma name: a bare "osmolality" is as often the urine test. It takes mOsm/kg, mOsmol/kg and mmol/kg, the same number.
- **Immature granulocytes in %, reticulocytes in %, and NRBC in % or per 100 WBC** are refused with a note pointing at the absolute count, as a differential in % is.
- **AMH** converts at the 140 kDa dimer convention (7.14 pmol/L per ng/mL), as insulin's 6.00 is one. Growth hormone in mIU/L and soluble transferrin receptor in nmol/L are assay-dependent and refused.
- **Left out:** the free thyroxine index (two scales share the name), every unitless ratio and index (TC/HDL, INR, free androgen index, HOMA-IR, A/G, BUN/creatinine), PT and APTT in seconds, base excess, and a bare "T4", "T3" or "troponin", which can mean either test. A printed one stays an uncatalogued row with its printed unit.

AC20 adds the comma, bracket and "absolute" spellings US, AU and NZ reports print for tests already catalogued ("Bilirubin, Total", "ALT (SGPT)", "Neutrophils (Absolute)"). Each of these spellings is listed. Since US-07 AC10 (Brad 2026-11-02), a name no listed spelling matches is tried once more without its punctuation: "A.M." and "P.M." lose their dots, and hyphens, dashes, brackets, commas, colons and slashes become spaces. That second try never changes how a name that already resolves resolves; a form two tests share resolves to nothing; a name that stays uncatalogued keeps its own slot, and since US-66 a core blood-test name gets the same second try, after the catalogue and never for a ratio ("/" or a colon before more words) or for "Cr", so "LDL - Cholesterol" files as LDL. "Urea Nitrogen (BUN)" takes BUN's mg/dL factor; "Urea (BUN)" does not (see the `urea` row). The extraction prompt offers every catalogue name (US-07 AC10, Brad 2026-11-02: "release now"); it still does not suggest the new core names or `bun`, which the resolver alone knows. What a US BUN in mg/dL does today depends on the name it arrives under. Under a printed nitrogen name ("BUN", "Urea Nitrogen", "Blood Urea Nitrogen (BUN)", or the extractor's `blood_urea_nitrogen`) it converts at ×0.357. Under "Urea (BUN)" or the bare `urea` it is refused. The assistant routes (`file_results`, `add_lab_values`) store the printed name, so they convert. The website now files a row by the name the report printed when it resolves (US-07 AC10), so a website "BUN" in mg/dL converts too; a row the model names only `urea` is still refused in mg/dL. The core resolver (not the prompt) gained the printed names on Brad's own reports ("Cholesterol (HDL)", "Cholesterol (LDL) (calculated)") and six more ("HDL-Cholesterol", "LDL-Cholesterol", "LDL Chol Calc (NIH)", "Glycated haemoglobin (HbA1c)", "PSA, Total", "Prostate Specific Ag"). A direct LDL is not yet a core alias: which LDL wins a day with both is open (US-21 AC19 notes).

Three-file sync: `evidence.ts` and `roadmap_text.html` are untouched because no threshold, suggestion or user-facing sentence changes — only the unit a stored number is expressed in. This holds for the 2026-10-20 additions too: no suggestion reads a catalogued test (`suggestions.ts` never reads `labValues`), so they are record-keeping only. If any of them ever drives a suggestion, all three files change.

**Cortisol by timing (US-07 AC9, Brad 2026-11-02, issue 476).** Cortisol is read against the time it was drawn, so each timing has its own entry, in nmol/L at the same 27.59 µg/dL factor. A name that prints no timing ("Cortisol") is a morning cortisol, `cortisol_am` "Cortisol (morning)", since most cortisol tests are drawn in the morning. AM or morning spellings go there too. A random cortisol goes to `cortisol_random` "Cortisol (random)". A PM, evening or (blood) midnight cortisol goes to `cortisol_pm` "Cortisol (PM)". Salivary and urine cortisol are not catalogued: they keep their printed names. A row stored earlier under a random or PM name was uncatalogued; slots are computed on read, so it now reads under its new entry, and one printed in µg/dL is converted at load by an appended correction row (`migrate.ts`, as for every newly catalogued test). A bare "Cortisol" row stays in `cortisol_am`. The upload prompt offers all three cortisol names (US-07 AC10, Brad 2026-11-02: "just switch over"). Punctuated spellings ("Cortisol, A.M.", "cortisol-pm", "P.M. cortisol") reach the same entries through the second, punctuation-free try above.

**Printed name decides (US-07 AC10, Brad 2026-11-02).** On a website or BYOK upload the model also returns each row's name as the report prints it. When that printed name resolves (the exact lookup or the punctuation-free one, never part of a name) to a core metric or a catalogued test, it decides where the row is filed, over the model's pick: a bare "Cortisol" is a morning cortisol whatever key the model chose, and a printed urine creatinine is a lab row, never serum creatinine. When it resolves to nothing, the model's pick stands. Specimen: when one name says urine or saliva and the other does not, the one that says it wins, for every test (a plain "Sodium" under a URINE heading stays urine sodium); for creatinine, a row the model listed among other tests is promoted when its printed name is a serum creatinine name; the unit check still refuses urine-only units. No review flag is added. A row the model lists among the core tests under a name that is no core key (US-12 AC11a), with or without a printed name, is filed by its printed name when it has one, or else by that name, and is never dropped, on every path that reads the model's answer, the connector's folder import included. As one of the 11 core values it keeps the model's confidence and question, also when a held slot leaves it a lab row that is offered as that core value; creatinine needs a printed serum creatinine name; weight, waist, height and any other name are lab rows; a row with no name at all is counted as not saved. Any other row with no printed name keeps the model's pick. No row is edited; chat, agent writes and the assistant's own read are unchanged.

---

## 3. Clinical Thresholds

Source: `units.ts`

All thresholds stored and compared in SI canonical units.

The cholesterol and triglyceride lines (Borderline, High, Very high, and HDL's Low line) are set in mg/dL, and the HbA1c lines in NGSP %. The code converts each exactly (mg/dL ÷ the factor in section 2, `hba1cNgspToIfcc`), so the mmol/L and IFCC figures in these tables are rounded for display: LDL High is 160 mg/dL, 4.1376 mmol/L, printed 4.14; HDL Low is 40 mg/dL, 1.0344 mmol/L, printed 1.03. A value typed at a printed figure can grade on either side of the line. The same holds for the rounded figures in `evidence.ts` (diabetes from 47.5 mmol/mol, very high triglycerides from 5.65 mmol/L, the first 2-dp value graded Very high). ApoB's lines are mg/dL ÷ 100, so its g/L figures are exact. The on-treatment Optimal targets are set in SI units (LDL 1.4 and non-HDL 1.6 mmol/L, ApoB 0.5 g/L); the mg/dL figure shown beside them is the first whole number the plan grades at or above the target (LDL 54.1 → 55, non-HDL 61.9 → 62).

### HbA1c (mmol/mol IFCC)

| Level | IFCC | NGSP % |
|-------|------|--------|
| Normal | < 38.8 | < 5.7% |
| **Prediabetes** | >= 38.8 | >= 5.7% |
| **Diabetes** | >= 47.5 | >= 6.5% |

### Why Fasting Glucose and Fasting Insulin Are Not Included

**Fasting glucose** — ADA recognizes fasting glucose ≥126 mg/dL as a diagnostic criterion for diabetes, but HbA1c captures 2–3 months of glycemic data rather than a single-point fasting snapshot. For a screening tool, HbA1c is more reliable and less sensitive to day-to-day variability. Note: HbA1c can be unreliable in patients with hemoglobin variants or conditions affecting red blood cell turnover — their clinician would order fasting glucose independently.

**Fasting insulin** — Can detect insulin resistance (via HOMA-IR) before glucose or HbA1c become abnormal. However, the assay is not standardized across labs and there are no universally agreed clinical thresholds, so it is not part of ADA/AHA/ACC screening guidelines. This makes it unsuitable for generalizable automated recommendations.

### LDL Cholesterol (mmol/L)

| Level | mmol/L | mg/dL |
|-------|--------|-------|
| Optimal | < 1.4 | < 55 |
| Above optimal | 1.4 | 55 |
| Borderline | 3.36 | 130 |
| High | 4.14 | 160 |
| Very high | 4.91 | 190 |

### Total Cholesterol (mmol/L)

| Level | mmol/L | mg/dL |
|-------|--------|-------|
| Borderline | 5.17 | 200 |
| High | 6.21 | 240 |

### Non-HDL Cholesterol (mmol/L)

LDL thresholds + 30 mg/dL for VLDL.

| Level | mmol/L | mg/dL |
|-------|--------|-------|
| Optimal | < 1.6 | < 62 |
| Above optimal | 1.6 | 62 |
| Borderline | 4.14 | 160 |
| High | 4.91 | 190 |
| Very high | 5.69 | 220 |

The Optimal line for LDL and non-HDL is the plan's on-treatment target (below). The tiles say "Optimal" below it and "Above optimal" (amber) from it up to Borderline; the history matrix colours LDL amber from 1.4 and red from High. Borderline, High and Very high are unchanged, and the `ldl-borderline` and `non-hdl-borderline` cards still show only in the Borderline band, naming the optimal line (<1.4 and <1.6 mmol/L; <55 and <62 mg/dL). ApoB needs no Above-optimal tier: its Borderline already starts at its 0.5 g/L target.

### HDL Cholesterol (mmol/L)

| Sex | Low threshold | mg/dL |
|-----|--------------|-------|
| Male | < 1.03 | < 40 |
| Female | < 1.29 | < 50 |
| Not on record | no threshold | no threshold |

With no sex on record the plan grades no HDL, so `hdl-low` does not show (US-07 AC8).

### Triglycerides (mmol/L)

| Level | mmol/L | mg/dL |
|-------|--------|-------|
| Borderline | 1.69 | 150 |
| High | 2.26 | 200 |
| Very high | 5.65 | 500 |

### Blood Pressure (mmHg)

| Threshold | Systolic | Diastolic |
|-----------|----------|-----------|
| Elevated | 120 | — |
| Stage 1 | 130 | 80 |
| Stage 2 | 140 | 90 |
| Crisis | 180 | 120 |

**Raised blood pressure** means one thing everywhere (the `bp-stage1` card and the weight-medication trigger): systolic >= 130 OR diastolic >= 80 (ACC/AHA 2017: stage 1 is 130–139 or 80–89; Brad 2026-11-03). Either half counts on its own; the stage cards still need both halves to show.

**Inverted blood pressure (US-02 AC8):** a pair from one day with systolic at or below diastolic is not a blood pressure. When the newest systolic and diastolic are from the same day and inverted, the plan leaves both out (`validateHealthInputs` names the rule on both), so it shows no blood pressure tier card and raises no marker, the weight-medication trigger included, until a half is corrected. The plan shows the `measure-bp` card in its "Check your blood pressure reading" form instead (section 4, Missing Measurements First; US-07 AC11). It does not fall back to an earlier day. Halves from different days are not judged as a pair and are used as before. Writes refuse such a pair (section 12); a merge of two devices' one-half corrections can still make one. `evidence.ts` and `roadmap_text.html` do not change: this is an input-integrity rule, with no new threshold, card text or citation.

**Age-dependent target** (based on SPRINT 2015 + ESPRIT 2024; `bpTargetFor` in `units.ts`, which the stage 1 card, the low-salt card, the Lp(a) checklist and the form's BP targets all read):
- Age < 65: < 120/80
- Age >= 65: < 130/80

### eGFR (mL/min/1.73m^2)

| Constant | Value | Meaning |
|----------|-------|---------|
| normal | 70 | eGFR 70 and over: the tile's "Normal" (named 2026-11-02; was a literal in `getEgfrStatus`) |
| lowNormal | 60 | eGFR 60-69, no CKD without markers |
| mildlyDecreased | 45 | CKD-3b boundary, protein adjustment |
| moderatelyDecreased | 30 | G3b |
| severelyDecreased | 15 | G4 |

**Labels (`getEgfrStatus`; US-07 AC9, Brad 2026-11-02, issue 474).** From 60 down the tile and card use KDIGO 2024's names and cut points. Normal and Low Normal are the tool's own bands: KDIGO calls 60-89 mildly decreased (G2), and G1-G2 are not chronic kidney disease without other markers of kidney damage.

| eGFR | Label | KDIGO 2024 |
|------|-------|------------|
| >= 70 | Normal | tool's own (G1 >= 90 normal or high; G2 60-89 mildly decreased) |
| 60-69 | Low Normal | tool's own (G2 mildly decreased) |
| 45-59 | Mildly to Moderately Decreased | G3a |
| 30-44 | Moderately to Severely Decreased | G3b |
| 15-29 | Severely Decreased | G4 |
| < 15 | Kidney Failure | G5 |

Source: KDIGO 2024 CKD guideline (Kidney Int 2024; DOI: 10.1016/j.kint.2023.10.018), cited on the card.

### ApoB (g/L)

| Level | g/L | mg/dL |
|-------|-----|-------|
| Borderline | 0.5 | 50 |
| High | 0.7 | 70 |
| Very high | 1.0 | 100 |

### PSA (ng/mL)

Flagged at 4.0 ng/mL or above (Brad 2026-11-12).

### Lp(a) (nmol/L)

| Level | nmol/L | ≈ mg/dL | ≈ mg/L |
|-------|--------|---------|--------|
| Normal | < 75 | < 30 | < 300 |
| Borderline | 75–125 | 30–50 | 300–500 |
| Elevated | >= 125 | >= 50 | >= 500 |

The plan grades in nmol/L. At the interim factor 2.5 nmol/L per mg/dL the mg/dL and mg/L columns convert exactly, so a value typed in either unit grades at the cut-point the guideline names.

Mass → molar is approximate: the plan uses nmol/L = 2.5 × mg/dL, the interim conversion factor EAS 2022 itself uses and the pairing of the cut-points it grades against: 30 mg/dL with 75 nmol/L and 50 mg/dL with 125 nmol/L (Kronenberg et al., EAS consensus, Eur Heart J 2022; the ACC/AHA risk enhancer ≥50 mg/dL ≈ ≥125 nmol/L). EAS also pairs 300 mg/dL with 750 nmol/L, and 180 mg/dL with 430 nmol/L (≈2.39); it does not recommend a standard conversion factor, and 2.5 is the interim one it uses itself. The true factor still runs ~2.0–2.5 with apo(a) isoform size, which is why guidelines prefer nmol/L (Marcovina & Albers, J Lipid Res 2016;57:526). The conventional (US) unit is mg/dL, the unit US labs print. NZ/AU/UK labs print mg/L (a tenth of mg/dL, so nmol/L ≈ 0.25 × mg/L; 93 mg/L ≈ 23 nmol/L): every import and agent writer accepts it through the unit alias table. The reference hint follows the "<X" rule of the on-treatment targets below (`formatTargetLine` on the 75 nmol/L line): "Normal: <75 nmol/L" in SI and "Normal: <30 mg/dL" in US units, since 29 mg/dL is 72.5 nmol/L (Normal) and 30 mg/dL is 75 (Borderline).

**The Lp(a) field takes three units** (US-05 AC2, 2026-10-13): nmol/L, mg/dL and mg/L, on one control where every other field has a two-way toggle, because US labs print mg/dL or nmol/L (Quest and LabCorp print nmol/L) and NZ/AU/UK labs print mg/L. The thresholds do not change: the plan grades in nmol/L, and a typed number is converted through the unit table (`reportedToCanonical`; mg/L is a tenth of mg/dL). nmol/L and mg/L show whole numbers; mg/dL shows one decimal place, the same step as whole mg/L (display only, 2026-10-13: at 2.5 nmol/L per mg/dL a whole mg/dL is 2.5 nmol/L, so whole numbers hid the cut-points: a stored 74 nmol/L, Normal, read "30 mg/dL" beside "Normal: <30 mg/dL", and 124, Borderline, read "50"; now 29.6 and 49.6). The hint is in the field's unit, by the same "<X" rule at that unit's display step, printed without a trailing zero: "Normal: <75 nmol/L", "Normal: <30 mg/dL" (29.9 mg/dL is 74.75 nmol/L), "Normal: <300 mg/L" (299 mg/L is 74.75 nmol/L). A value stated in the chat fills the cell as stated, in the unit it was stated in, and saves exactly that (49.6 mg/dL saves 124 nmol/L in any field unit). Default with no unit chosen: mg/dL in US units, nmol/L in any other. The unit chosen is kept in the record (`profile.lpaUnit`), so it follows the user across devices. Legacy reads, never rewritten: with no `lpaUnit`, the old build's two-way toggle for Lp(a) on the device ('conventional', which then meant mg/L) opens the field in mg/L, and 'si' in nmol/L. An unsaved Lp(a) draft from before the change has no unit kept with it, so it is never guessed: the cell asks for it to be typed again. The plan's own displays (stat card, suggestion titles and text) keep printing Lp(a) in nmol/L. Corrected 2026-09-07: the code had applied 2.4 per mg/L, storing every mg/L reading 10× high. Corrected 2026-10-13: the US-units field was labelled mg/L, a unit US labs never print, so a US mg/dL result typed into it (from 2026-09-07) was stored 10× low (156 mg/dL as 37 nmol/L, Normal, instead of 390, Elevated). Until then the US hint read "Normal: <75 nmol/L" beside the mg/L field. The same day the factor moved from 2.4 to 2.5 nmol/L per mg/dL: at 2.4 an imported US 50 mg/dL (the mg/dL alias, 50 × 10 × 0.24) graded Borderline (120 nmol/L) against the guideline's Elevated; the form read a typed 50 as mg/L, 12 nmol/L. Since 2026-10-13 the page asks about each such row instead of migrating it (US-05 AC3): an active Lp(a) value written by a typed path between the 2026-09-07 release (03:53 UTC) and the fix's release (2026-10-13 02:30 UTC), on a device in US units (there the field showed the US default, mg/L), gets a question below the blood-test matrix. An old Lp(a) toggle set to mg/L ('conventional') excludes the device: that user chose the old mg/L and typed real mg/L. One set to SI does not: that user may have typed into the default mg/L field before toggling. The user answers with a number and its unit, the number being the saved value read back at 0.24: "My report says <n> mg/dL" writes a correction of n × 2.5 nmol/L, "My report says <n> nmol/L" writes n, and "My report says <n> mg/L (saves <n × 0.25> nmol/L)" writes n × 0.25, today's factor, since the old field stored a real mg/L at 0.24, 4% low. "Neither of these" keeps the value, and so does any answer that would save the stored value, to 12 significant digits: it writes nothing. A report above 300 mg/dL (n × 2.5 over 750) is a real result past the record's range: its answer reads "My report says <n> mg/dL (saves 750 nmol/L, the highest value this tool records)" and writes exactly 750, and the question then says "This tool records Lp(a) up to 300 mg/dL (750 nmol/L). If your report shows a higher number, that result is very high: please discuss it with your doctor." An nmol/L or mg/L correction the record would refuse (over 750 nmol/L) is not offered. The connector, the CLI and a chat prefill write the same sources as the form and stored their rows right, so such a row may be asked about; its report matches neither number shown (a Quest 120 nmol/L is offered "500 nmol/L"), and Neither keeps it. Three-file sync: `evidence.ts` ("≥125 nmol/L") and `roadmap_text.html` ("Ideal level: <75nmol/L") state only the canonical nmol/L thresholds and no conversion factor, and those thresholds did not change, so neither file needs an edit. The check's answers, the mg/L correction at 0.25 and the 750 nmol/L ceiling included, change no threshold, reason or citation, so `evidence.ts` and `roadmap_text.html` are unchanged.

### On-Treatment Lipid Targets

Used when medications are tracked and a lipid is at or above its target: the value should be below it, so the target itself counts as above target (Brad, 2026-09-28). Cards and the form say "the treatment target is below X". Every "<X" statement of a lipid target (these cards, the borderline cards, the Lp(a) checklist and the reference hints) prints X as the first value, at the unit's display step, that the plan grades at or above the target (`formatTargetLine`): 0.50, 1.4 and 1.6 in SI; 50, 55 and 62 in mg/dL. 54 mg/dL of LDL is 1.396 mmol/L, which the plan grades below 1.4, so the mg/dL target reads 55. The LDL and non-HDL targets are also the tiles' Optimal line and the `lipid-diet` trigger, which use the same `>=` comparison. In the read-only summaries, a value printed beside its target (the cards' "Your LDL-c is…" sentence, the form's cholesterol intro, the Lp(a) checklist, the lipid tile and the MCP `get_plan` currentValues) shows on the side of X the plan grades it (`formatGradedValue`). It rounds to the display step as everywhere else, unless that would put it on the other side of X. Then a value graded at or above the target shows X, and a value graded below it shows one more decimal place, rounded down, which is always below X. So 1.40 mmol/L of LDL, at the target, shows as 55 mg/dL, not 54; 54 mg/dL (1.3964 mmol/L), below it, shows as 1.39 mmol/L, not 1.4; a non-HDL of 1.56 shows as 1.56. A value typed in the shown unit, on the display step, shows as typed. HbA1c and Lp(a) follow the same rule at each of their grade lines (5.7 and 6.5 %, 75 and 125 nmol/L) in their tiles, the cards (with the Lp(a) checklist's HbA1c line) and `get_plan` (`formatGradedReading`, US-07 AC15): 47 mmol/mol, graded prediabetic, shows as 6.45 %, not 6.5 %. The history matrices (blood tests and vitals) are editable, so they show plain values, rounded to the display step: the number a typed value is compared against, so re-entering the shown number writes nothing (US-03 AC3). Their colour is the plan's grade. So a value within one display step of its line, entered in the other unit, can read on the other side of the hint there: 1.40 mmol/L of LDL shows as 54 mg/dL beside "<55", coloured above optimal.

| Marker | Target | Conventional |
|--------|--------|-------------|
| ApoB | < 0.5 g/L | < 50 mg/dL |
| LDL | < 1.4 mmol/L | < 55 mg/dL |
| Non-HDL | < 1.6 mmol/L | < 62 mg/dL |

ApoB source: Brad's target, extended from the Ez-PAVE LDL-C target trial (Lee 2026) and PESA (Ibanez 2021), and lower than the ESC/EAS 2019 goal of < 65 mg/dL for very high risk.

### Results Printed as a Limit (US-12 AC20)

Source: `lab-limits.ts`. Brad, 2026-11-02: "Only when it decides".

A lab result printed with a symbol ("> 60", "< 5", "≤ 0.1") is saved as its bound with its comparator, never as the bound alone. The plan grades it only when the bound decides: when no cutoff the input is compared against lies inside the band the limit leaves open, so every value in the band grades the same.

- **Two cutoff lists per input.** The plan's grading lines (`LIMIT_CUTOFFS`): every threshold in this section the cards, calculations, gates, on-treatment targets and medication cascades compare the input against, for any sex and any treatment state. eGFR's is 45 alone (the protein cut and the potassium gate); the systolic list holds both targets, 120 and 130; creatinine has none; PSA's line is 4.0. The label lines (`LIMIT_LABEL_CUTOFFS`): what the tiles' status words and the blood-test grid colours compare it against: eGFR 70, 60, 45, 30 and 15; HDL's and creatinine's grid bands by sex, both sexes listed; PSA 4.0; triglycerides' grid line 2.26. The orchestrator split them on 2026-11-02, because the 70 line drives only a label. Non-HDL's lines are in neither list: non-HDL is derived, and never from a limit. A non-core lab graded by its printed reference range uses that range; a printed bound of exactly 0 is no cutoff (CRP's "0–5" leaves "< 1" decided), while a negative bound is one (base excess "−2 to 2").
- **Decides when:** `< b` and every cutoff is at or above b; `<= b` and every cutoff is above b; `> b` and every cutoff is at or below b; `>= b` and every cutoff is below b. The same lists for everyone, conservative on purpose. The plan decides against its grading lines. A tile word or grid colour shows only when the limit also decides against the label lines; otherwise the tile shows the limit with no word and the grid no colour.
- **Decided:** the plan grades a representative strictly inside the band, halfway between the bound and the input range's far end (section 12), so no rounding moves it across the bound. It must pass the input range, or the limit is undecided. It is never shown, stored or sent: every surface shows the bound with its symbol.
- **Undecided:** the input has no graded value. No card, tile grade or cascade step comes from it, it is not counted missing, and no older exact value stands in for it. It is shown with its limit and "Printed as a limit, so the plan cannot grade it against its cutoff.", except for a known minor, whose adult lines grade nothing, exact or limit: there it shows no note (US-12 AC21).
- **Vitals (US-12 AC21, Brad 2026-11-02: "grade only when certain"):** a weight, waist or blood pressure printed as a limit gets a colour and a spoken grade only when its grade is the same for every value consistent with its bounds. Weight and waist by the same "decides" test against the vitals grade's own lines: weight's ideal weight minus 5 kg, plus 2 and plus 5; waist's healthy-ratio line (0.495 x height) and half the height plus 8 cm. A blood pressure's grade is the worse of its halves' (systolic at the target and target plus 10, diastolic at 80 and 85), each worsening as it rises, so the fewest and the most lines each half's bound allows reach decide it, judged exactly from which side of each line the bound lies and whether it is strict: a half certainly at the worst grade makes the pair that grade whatever the other half ("> 160/< 90" is high); both halves certain, the worse; otherwise ("< 125/78") no grade. Otherwise no colour, and the note above, but only where there is something to grade against (an adult's plan; for weight an ideal weight, for waist a height): with none, no note, as an exact value. The same rule on the web and the iPhone (`certainValue`, `linesReached`, `limitUngraded`; `row-grade.ts`).
- **Derived values** never use a limit: no non-HDL from a limit HDL or total cholesterol, no eGFR calculated from a limit creatinine, no ratio, trend or percent change. A lab eGFR printed as a limit is graded by the rule above; with an undecided one the plan has no eGFR and does not calculate one from an older creatinine. A newer creatinine printed as a limit leaves an older lab eGFR standing, marked outdated (the same treatment as a newer creatinine the plan cannot read).
- An undecided ApoB lets the lipid marker fall to non-HDL or LDL, as when there is no ApoB.
- **Examples:** eGFR "> 90" decides, tile word included; eGFR "> 60" decides for the plan (protein target 1.2 g/kg, potassium advice open) and its tile shows "> 60" with no word; eGFR "> 30" does not decide (45 lies above it); Lp(a) "< 10" nmol/L, PSA "< 0.01" ng/mL and HDL "> 1.5" mmol/L decide; LDL "< 1.5" mmol/L does not (the 1.4 target lies below).

### VO2 Max Fitness Bands (iPhone app, display only)

US-56 AC8 (Brad 2026-10-26; the Low line from 60, Brad 2026-10-27). The iPhone app's VO2 max page shades four bands behind its chart, and its card names the newest reading's band. Display only: no suggestion reads VO2 max, which never enters the record. Source: FRIEND 2022, Table 3, treadmill CPX with directly measured VO2peak, RER ≥ 1.0 (Kaminsky et al., Mayo Clin Proc 2022;97(2):285-293). Apple publishes only its Low rule ("Using Apple Watch to Estimate Cardio Fitness with VO2 max", May 2021, p. 5): for ages 20 to 59, the lowest fifth of FRIEND 2015 (Kaminsky 2015) by sex and decade; at 60 and over, fixed lines of 18 mL/kg/min for men and 15 for women. From age 60, Low uses Apple's Low Cardio Fitness alert line (below 18 mL/kg/min for men, 15 for women) (Brad 2026-10-27). Apple says it uses fixed lines from 60 because data suggest these are thresholds for independent living at the extremes of age, so at older ages Low is a functional line rather than a percentile. From 20 to 59 it stays FRIEND 2022's P20: the 2015 table publishes no 20th percentile, so Apple's line there cannot be matched exactly.

| Band | Rule |
|------|------|
| Low | below P20 (from 60: below 18 for men, 15 for women) |
| Below Average | the Low line to below P50 |
| Above Average | P50 to below P80 |
| High | P80 and above |

Each band includes its lower bound. A band with no room is left out of the legend and the shading: for men 80 to 89, Apple's 18 is above P50 (17.6), so below 18 is Low, 18 to below 21.4 Above Average, 21.4 and up High, and there is no Below Average. The app places the value as shown, rounded to one decimal. Ages 20 to 89; no band under 20, at 90 or over, or without sex and birth year in the record. Age follows the Age rule in section 1, and is the person's age today, also for older readings.

| Age | Men P20 | Men P50 | Men P80 | Women P20 | Women P50 | Women P80 |
|-----|---------|---------|---------|-----------|-----------|-----------|
| 20–29 | 35.2 | 46.5 | 54.5 | 27.2 | 36.6 | 44.8 |
| 30–39 | 29.8 | 39.7 | 50.0 | 21.9 | 28.3 | 37.0 |
| 40–49 | 26.7 | 35.3 | 45.2 | 19.7 | 25.7 | 33.0 |
| 50–59 | 22.2 | 29.2 | 38.3 | 18.5 | 22.9 | 28.4 |
| 60–69 | 18.5 | 24.6 | 32.0 | 15.4 | 19.6 | 24.3 |
| 70–79 | 15.9 | 20.6 | 25.9 | 14.0 | 17.2 | 20.8 |
| 80–89 | 14.8 | 17.6 | 21.4 | 12.6 | 15.4 | 18.4 |

Values in mL/kg/min. The table is FRIEND 2022's, unchanged; from 60 the app uses Apple's line in place of the P20 column:

| Age | Men Low line | Men P50 | Men P80 | Women Low line | Women P50 | Women P80 |
|-----|--------------|---------|---------|----------------|-----------|-----------|
| 60–69 | 18 | 24.6 | 32.0 | 15 | 19.6 | 24.3 |
| 70–79 | 18 | 20.6 | 25.9 | 15 | 17.2 | 20.8 |
| 80–89 | 18 | 17.6 | 21.4 | 15 | 15.4 | 18.4 |

Code: the table and Apple's two lines (`APPLE_LOW_FROM_60`) are `packages/health-core/src/vo2max-bands.ts`; the app's engine serves the person's row on My data (`vo2Bands`, ios/engine/my-data.ts, by `calculateAge`), and the app applies its cut-points to a value (`Vo2MaxBands.swift`). Apple Watch estimates VO2 max from submaximal walks, runs and hikes; FRIEND's values come from maximal lab treadmill tests, so the comparison is approximate.

---

## 4. Suggestion Algorithm

Source: `suggestions.ts` -> `generateSuggestions()`

The plan reads the latest active value per metric, day first, then time (`compareReadings`, US-07 AC4, Brad 2026-11-09). Each reading counts on the calendar day it was stored with (a date with no time is that day), and a later day always wins: a value typed for 2 November beats one recorded on the evening of 1 November, in any time zone. On the same day the later moment wins (a date with no time counts as 00:00 UTC); a time that cannot be read ranks below every one that can, and readings at the same moment fall back to the later write, then the id.

### Who the Plan Is For

The plan is built for adults aged 18 and over (US-07 AC6, 2026-10-14; amended the same day). Its thresholds, targets and medicines come from adult guidelines.

| Age | Plan |
|-----|------|
| Known and under 18 | No suggestions of any kind. One card in their place: `adults-only` (general, info), "This plan is built for adults": "The suggestions here, including medicines, are designed for people aged 18 and over. For anyone younger, talk with their doctor." |
| 18 or over | The plan below, unchanged. |
| Unknown (no birth year) | The plan below, except the medicine cards. Medicine cards need a known age of 18 or over. When the plan would show any, they give way to one card where the first stood: `add-birth-year` (general, info), "Add your birth year": "Medicine suggestions need your age. Add your birth year to see them." Every other card is unchanged. The standalone lipid cards (`apob-*`, `non-hdl-*`, `ldl-*`, `total-chol-*`) never give way to the lipid cascade here, because the cascade is not shown. No weight card gives way to the weight cascade, at any age. The kept cards suggest no medicine in their own text: `apob-very-high` ends "Discuss treatment, including lifestyle changes, with your doctor." and `ldl-very-high` "Discuss treatment with your doctor." in place of their statin sentence, `bp-stage2` says "Discuss treatment with your doctor." in place of "Guidelines typically recommend medication at this level. Discuss it with your doctor.", `bp-stage1` and `bp-stage2` keep their weight-loss sentences but leave out "GLP-1 medications (tirzepatide, semaglutide) can assist with both weight loss and blood pressure reduction.", and the `lpa-elevated` checklist leaves out its "not started" medicine lines. One exception, by decision: `ldl-high` keeps "Consider lifestyle modifications and discuss medication options." It names no medicine, and discussing is not suggesting. |

**Unknown sex (US-07 AC8, Brad 2026-10-31).** The plan needs only a height. A stored sex that is not male or female counts as none (the record is not changed). With no sex on record it is the plan above, minus every part that needs sex: the ideal body weight, the protein target and its `protein-target` card, a calculated eGFR (a lab-printed one still stands, and a calculated one cannot outrank it; when a newer creatinine exists, that lab eGFR opens no potassium advice), the `hdl-low` card, and the sex-specific screenings (breast, cervical, prostate, endometrial, bone density), as cards and as reminders in `due` (section 11). Nothing falls back to a male or female default. BMI, the waist-to-height ratio and every unsexed card are unchanged. `get_plan` returns `profile.sex`, `idealBodyWeightKg` and `proteinTargetG` as `null`, names `sex` in `missingInputs`, and lists the missing parts in `profile.needsSex`. No usable height is still no plan. The website's blood-test grids and My data rows give HDL and creatinine no colour and no spoken grade with no sex on record, and assume no sex (US-62 AC13); their hints show both lines ("Optimal: >1.0/>1.3" for HDL; "Normal: 60–110 (men) / 45–90 (women)" for creatinine, "Normal 60–110/45–90" in a row). With sex, each is coloured on its own line: HDL ok from 1.03 mmol/L (men) or 1.29 (women), red below 1.03; creatinine ok to 110 µmol/L (men) or 90 (women), red from 1.3 × that ceiling. The numbers live in `units.ts` (`HDL_GRID_BANDS`, `CREATININE_GRID_BANDS`).

Three-file sync for US-07 AC8: `evidence.ts` needs no change. No card's reason, guideline tag or citation changes, and the sex-specific "why" texts (ideal body weight, BMI) are built only when sex is known. `roadmap_text.html` needs no change. It describes how each number is worked out, which is unchanged when sex is known, and its eGFR sentence ("uses your creatinine level along with your age and sex") stays true: with no sex there is no calculated eGFR.

The medicine cards are the `medication` category: `weight-glp1`; `weight-med-glp1`, `-glp1-dose`, `-glp1-increase`, `-glp1-switch`, `-sglt2i`, `-metformin`; `med-statin`, `-ezetimibe`, `-bempedoic-acid`, `-statin-dose`, `-statin-increase`, `-statin-switch`, `-pcsk9i`.

The gate's age (`isKnownMinor`) is the one in section 1, except that a missing birth month is strict: the person is a minor until 1 January of the year after the year they turn 18 (birth year + 19), so no one counts as 18 early. Someone born in 2008 with no month is a minor through 31 December 2026 and an adult from 1 January 2027. A known month keeps the birthday-month rule. The gate reads the date at UTC−12, the zone furthest behind, whatever zone it runs in (the hosted server runs in UTC), so no one anywhere counts as 18 early: the new month or year starts for the gate at 12:00 UTC on its first day (born November 2008: an adult from 1 November 2026 12:00 UTC; born 2008 with no month: from 1 January 2027 12:00 UTC). Every other age keeps the January default and the local date, so that person's profile reads 18 beside the adults-only card through 2026 (accepted). Every surface (the plan, the reminder schedule, the form, the chat context) asks the gate over the birth year and month the plan keeps (`knownMinorOf`): one outside the plan's bounds (birth year 1900 to this year, month 1 to 12) counts as missing, so no surface calls someone a minor while the plan has no age for them.

For a known minor, every surface also withholds:

- **Adult readings.** The BMI category, ideal body weight, protein target and eGFR (an adult's eGFR also needs a creatinine taken when they were not a known minor: section 1, eGFR), and the status labels on the lipid, HbA1c and Lp(a) tiles, with the "why" behind each. The website tiles and the PDF show the raw numbers only (BMI, lipid marker, Lp(a), HbA1c); the ideal body weight, protein and eGFR tiles go. `get_plan` returns `bmiCategory`, `eGFR`, `idealBodyWeightKg` and `proteinTargetG` as `null`; the CLI prints the BMI with no category and no eGFR. Raw values (weight, height, waist, each lab value with its unit and date) are untouched.
- **The schedule.** `computeReminderSchedule` returns nothing, not even the annual check-in floor, so `get_plan`'s `due` is empty. The browser never enrols a known minor in reminders, never pushes their schedule (the server would add its annual check-in to any schedule it is sent), and turns off a row enrolled earlier with the widget's own cancel. That cancel is the age gate's, not the user's: it is permanent (at 18 they turn reminders on by hand) and is not counted as an opt-out.
- **The form's medicine wording.** The medication sections are plain fields with their neutral sentence: no recommendation, target sentence or step hint. People can still record what they take. The form does the same for an unknown age, because it follows the plan (US-06 AC5).
- **The form's adult targets.** The weight row's "Target: <ideal body weight>", the blood-pressure target and its status colours, and the reference hints and status colours of the blood-test matrix (saved values, the draft column and the correction editor) and the upload review matrix. The form reads the validated birth year and month alone, so this holds with no plan too (no height or sex). The values stay and stay editable, and no empty box is left. The waist line, its colour and the waist-to-height tile stay: the 0.5 ratio is also used in children. Every one of these targets and hints has one source, health-core's `rowTarget` (US-62 AC9): the grids print its full line and the phone's My data rows the same target without its unit ("Normal <5.7"), so the rule above holds on both, and on the upload review.

Measurements, lab values and the record are untouched: they are still stored and shown. There is no usage signal: an event would record that a visitor is under 18.

**Reasons stay for every age.** A card's "Why this suggestion?" reason is keyed by its id and explains the guideline, so it does not change with age: `apob-very-high` still says statin therapy "is typically recommended" and `ldl-very-high` that guidelines "recommend statin therapy at this level". A reason does not suggest a medicine to this person; the card text does, and that is what changes for an unknown age. Since 2026-11-13 (US-25 AC28) the `apob-very-high`, `ldl-very-high`, `non-hdl-very-high` and `bp-stage2` reasons follow their treatment sentence with "Discuss it with your doctor."; that line hands the decision to the doctor, it does not suggest the medicine, so it stays for every age too.

Three-file sync for this section's 2026-10-14 amendments (the strict missing-month rule, the UTC−12 date, the lipid cards kept for an unknown age and their medicine-free text, the BP cards' GLP-1 sentence withheld for an unknown age, the form's and review's withheld readings):
- `evidence.ts`: no change. No card's reason, guideline tag or citation changed; the `adults-only` and `add-birth-year` reasons still hold.
- `roadmap_text.html`: no change. Its two sentences still hold: the plan "is built for adults aged 18 and over", and the medicines are suggested "only when your birth year shows you are 18 or over" (the strict rule and the UTC−12 date only make that later; with no birth year no card's text suggests one, and the reasons explain the guideline, as above).

### Missing Measurements First (US-07 AC11)

Brad, 2026-11-02: when the waist is not on record, measuring it is always the first next step; when no blood pressure is on record, measuring it comes next. Both cards are attention, not urgent. They lead the Next Steps section in this order, ahead of every category (screenings included), on the web and the iPhone alike: `planSections` puts these two ids first, then lays out the other cards by category as before. The engine also emits them first, so the chat and agents read them first.

| ID | Category | Condition | Priority | Text |
|----|----------|-----------|----------|------|
| `measure-waist` | general | No waist on record (no waist-to-height ratio), at any BMI (35 and over included), and with no weight yet. The plan needs only a height | attention | "Measure your waist circumference": "Fat around the middle raises heart and metabolic risk, even at a healthy weight. Aim for a waist under half your height. Add your waist measurement." One text for every BMI (Brad, 2026-11-02) |
| `measure-bp` | blood_pressure | No systolic or no diastolic on record (the BP tier cards need both halves) | attention | "Measure your blood pressure": "High blood pressure usually causes no symptoms, yet it raises the risk of stroke, heart attack and kidney disease. A simple automated upper-arm cuff at home is all you need. Sit quietly for a few minutes, then add your reading. Aim for below 120/80 (130/80 if you're frail)." One sentence at every age (Brad, 2026-11-02: "It's just 130 if frail"): neither this card nor its reason uses the age rule. The tier cards and the tiles keep it (section 3) |
| `measure-bp`, swapped reading | blood_pressure | The newest pair was the wrong way up, so the plan left both halves out (section 3, US-02 AC8). `planInputsFrom` (plan.ts), shared by the plan and the web form, strips the pair and sets `pressureOrder`; the chat context sets it from its own check | attention | "Check your blood pressure reading": "Your last reading looks swapped: the top number (systolic) should be higher than the bottom (diastolic). Check it and add it again." Same id and place |

Evidence: `measure-waist` keeps AACE 2025, NICE and Ashwell 2012 (WHtR a better screen for cardiometabolic risk than BMI). Its reason, approved by Brad 2026-11-02, fits every BMI: "Fat around the middle is linked to heart and metabolic risk. Waist-to-height ratio can flag risk that a healthy BMI misses; the AACE 2025 and NICE guidelines suggest keeping it under 0.5." Both forms of `measure-bp` share one reason, with no age: "This plan aims for <120/80 mmHg, as some doctors do, based on the SPRINT and ESPRIT trials, or <130/80 mmHg if you're frail." It cites the 2017 ACC/AHA guideline (Whelton 2017) and the SPRINT and ESPRIT trials behind the <120/80 target, the references the BP cards already use. `roadmap_text.html` is unchanged: its Blood Pressure section advises home monitoring with an automated cuff and describes the tier targets (<120/80 under 65, <130/80 at 65 or older), which the tier cards and tiles still use; it quotes neither prompt's text and does not describe the waist prompt.

### Always-Show Lifestyle Suggestions

| ID | Category | What | Evidence |
|----|----------|------|----------|
| `protein-target` | nutrition | Daily protein target (CKD-adjusted if eGFR < 45). Needs sex: absent with no sex on record (US-07 AC8) | ISSN 2017 |
| `fiber` | nutrition | 25-35g fiber daily | Reynolds 2019; Hartley 2016 |
| `exercise` | exercise | At least 150 min moderate cardio, or 75 min vigorous, or a mix (1 vigorous min = 2 moderate) + 2-3 resistance sessions/week | WHO 2020; Physical Activity Guidelines 2018 |
| `sleep` | sleep | 7-9 hours nightly | Cappuccio 2010 |

**Exercise safety (display text, Brad 2026-11-01):** roadmap_text.html's Exercise safety paragraph says only: stop if you get chest pain, dizziness, fainting, palpitations or unusual breathlessness, and see your doctor before you exercise again (Franklin 2020, AHA scientific statement, DOI: 10.1161/CIR.0000000000000749). The Apple Watch heart rate paragraph above it says (Brad 2026-11-02 moved it there, so the safety paragraph gives one instruction): get emergency care for chest pain, whatever your pulse (Gulati 2021, AHA/ACC chest pain guideline, DOI: 10.1161/CIR.0000000000001029), or for a racing pulse with fainting, dizziness or breathlessness (NHS Arrhythmia, 2024, www.nhs.uk/conditions/arrhythmia). A very slow pulse with fainting, dizziness or breathlessness needs prompt medical care (Kusumoto 2019, ACC/AHA/HRS bradycardia guideline, DOI: 10.1161/CIR.0000000000000628). The iPhone's heart rate guide (`heart_rate` in `metric-guides.ts`) repeated the last two lines; it was deleted with the app's heart rate reads (Brad 2026-11-06), and the web page keeps them. The resting heart rate guide stays. No card or threshold changes.

### Conditional Lifestyle Suggestions

| ID | Condition | Priority | Notes |
|----|-----------|----------|-------|
| `low-salt` | systolicBp > 120 (age < 65) or > 130 (age >= 65) | info | Target: <1,500 mg/day (ACC/AHA 2017). Salt substitute line (US-07 AC13, Brad 2026-11-02), shown only with a current eGFR of 45 or more (Brad 2026-11-09): the same `potassiumSafe` check as the `high-potassium` card (eGFR >= `EGFR_THRESHOLDS.mildlyDecreased` and not `labEgfrOutdated`), so with no eGFR, an eGFR below 45 or one a newer creatinine has outdated it is left out: "A potassium-enriched salt substitute can also help cut sodium, but not if you are pregnant, have kidney disease or diabetes, have been told to limit potassium, or take a potassium-sparing diuretic, a potassium supplement, an ACE inhibitor or an ARB, unless your doctor agrees." Sources: SSaSS (Neal 2021, N Engl J Med, DOI: 10.1056/NEJMoa2105675); 2025 AHA/ACC guideline (useful except in kidney disease or with medicines that reduce potassium excretion; Gulati 2025, DOI: 10.1016/j.jacc.2025.07.010); diabetes, pregnancy and older people from NICE NG136 1.4.5 (verified 2026-11-09: not for older people, people with diabetes, pregnant women, people with kidney disease or people taking some antihypertensives, such as ACE inhibitors and ARBs). The card names pregnancy; the reason adds that NICE also advises against them for older people (Brad 2026-11-09). |
| `high-potassium` | eGFR >= 45 (safe kidney function), from an eGFR no newer creatinine has outdated (US-07 AC8, section 1) | info | |
| `trig-nutrition` | triglycerides 150 mg/dL (about 1.7 mmol/L) or more | attention | Its text names "limit alcohol" among the key measures, except for someone who answered "I don't drink": then "Key measures: reduce sugar intake, and reduce total fat and calorie intake." (US-60, Brad 2026-10-31). Its evidence reason is one text for everyone: "reducing sugar and total calorie intake, and reducing alcohol for people who drink." |
| `reduce-alcohol` | (BMI >= 30, OR (BMI >= 25 AND WHtR >= 0.5), OR triglycerides 150 mg/dL (about 1.7 mmol/L) or more), and the person has not answered "I don't drink" | attention | "I drink" or no answer keeps the card (US-60) |

### The Alcohol Question (US-60)

The plan asks one question, from the "Reduce alcohol intake" card's Dismiss button: "Do you drink alcohol?" There are two answers, "I don't drink" and "I drink" (Brad 2026-10-31, C1).

- **Where it lives:** `profile.alcohol` in the record, `'none'` or `'drinks'`; the plan reads it as `HealthInputs.alcohol`. Absent means not answered.
- **What it changes:** "I don't drink" leaves out `reduce-alcohol` and drops "limit alcohol" from `trig-nutrition`'s text (above). "I drink" changes nothing: the card stays (C4). `trig-very-high` is unchanged for everyone (C3).
- **Changing it:** the Alcohol row in Starting Info (web) or About you (iPhone) shows Not answered, I don't drink and I drink. Not answered clears the field (a stamped null, as any cleared profile field), and the card comes back (M2).
- **Never re-asked:** the plan does not ask again on its own; the answer stays until the person changes it (C5).
- **Across devices:** the profile merges field by field, newest write wins, so the last answer given on any device wins (M1).

Three-file sync: `evidence.ts` changes one sentence, `trig-nutrition`'s reason (above); `trig-very-high`'s and `reduce-alcohol`'s reasons are unchanged. `roadmap_text.html` is unchanged: it gives no triglyceride advice about alcohol, and its alcohol lines ("No Smoking and Limited (ideally no) Alcohol Consumption", the blood pressure and sleep lists) are general guidance for everyone, not a card's text.

### HbA1c Tiers

| ID | Condition | Priority |
|----|-----------|----------|
| `hba1c-diabetic` | >= 47.5 mmol/mol (>= 6.5%) | urgent |
| `hba1c-prediabetic` | >= 38.8 mmol/mol (>= 5.7%) | attention |
| `hba1c-normal` | < 38.8 mmol/mol | info |

### Atherogenic Lipid Hierarchy

**Guidelines:** 2026 ACC/AHA Dyslipidemia Guideline (JACC, DOI: 10.1016/j.jacc.2025.11.016), ESC/EAS 2019.

**Only show the best available marker:** ApoB > non-HDL > LDL.

ApoB is always shown when available. LDL is only shown when both ApoB AND non-HDL are unavailable. Non-HDL is only shown when ApoB is unavailable.

Each marker has three tiers (borderline/high/very high) using the thresholds in section 3.

**Total cholesterol** is suppressed when an elevated atherogenic marker already produced an attention/urgent suggestion, or when the lipid medication cascade is active.

**The lipid medication cascade is active** when a statin status is recorded, the plan's marker is at or above its target, and the age is known. Then the marker's own card and total cholesterol give way to the cascade, whose cards carry the value. With no birth year the cascade is not shown (US-07 AC6), so nothing gives way to it.

### Lp(a)

**Guidelines:** 2026 ACC/AHA Dyslipidemia Guideline (Class I: measure Lp(a) at least once in all adults), EAS 2022.

| ID | Condition | Priority |
|----|-----------|----------|
| `lpa-elevated` | >= 125 nmol/L | attention |
| `lpa-borderline` | 75-125 nmol/L | info |
| `lpa-normal` | < 75 nmol/L | info |

**Elevated Lp(a) checklist** (modifiable risk factors):
- Lipids (ApoB > non-HDL > LDL, on-treatment targets; ⚠️ at or above the target, shown as "target <X")
- Blood pressure (the age-dependent target: < 120/80 under 65, < 130/80 at 65 or older)
- BMI (target < 25; shows ✅ when BMI 25–29.9 with WHtR < 0.5)
- HbA1c (target < 38.8 mmol/mol)
- Medication status (statin, ezetimibe, PCSK9i — when tracked; with no birth year the "not started" lines are left out, and what the user takes or did not tolerate stays)
- PCSK9i note: also lowers Lp(a) ~25-30%

### HDL and Triglycerides

| ID | Condition | Priority |
|----|-----------|----------|
| `hdl-low` | HDL < sex-specific threshold; never with no sex on record | attention |
| `trig-very-high` | triglycerides >= 5.65 mmol/L (500 mg/dL) — pancreatitis risk | urgent |

`trig-very-high` is the same for everyone, the alcohol answer included: its evidence reason keeps "strict alcohol and sugar avoidance" on purpose for a non-drinker too (US-60 C3, Brad 2026-10-31). It is an urgent safety card, and the advice does no harm to someone who does not drink.

### Blood Pressure Tiers

| ID | Condition | Priority |
|----|-----------|----------|
| `bp-crisis` | sys >= 180 OR dia >= 120 | urgent |
| `bp-stage2` | sys >= 140 OR dia >= 90 | urgent |
| `bp-stage1` | sys >= 130 OR dia >= 80 | attention |

`bp-crisis` text (US-07 AC12, Brad 2026-11-02 approved "recheck after 5 minutes; if still that high, call your doctor"): "Your BP of {sys}/{dia} mmHg is dangerously high. If you have no symptoms, rest and recheck it after 5 minutes; if it is still 180/120 or higher (either number), call your doctor. If you have chest, back or belly pain, shortness of breath, numbness or weakness, a change in vision, difficulty speaking or a sudden severe headache, call your local emergency number (111 in NZ, 000 in Australia, 911 in the US, 999 in the UK)." Source: NHLBI, High Blood Pressure: Symptoms (www.nhlbi.nih.gov/health/high-blood-pressure/symptoms): at 180/120 without symptoms "wait 5 minutes and check your blood pressure again", then call your healthcare provider if still high; with a sudden severe headache, difficulty breathing, sudden severe pain in the abdomen, chest or back, numbness or weakness, a sudden change in vision or problems talking, call emergency services.

Stage 1 shows age-dependent target: < 120/80 for age < 65, < 130/80 for age >= 65.

With no reading on record (either half missing), none of these shows; `measure-bp` asks for one instead (Missing Measurements First, above).

Stage 1 and 2 include conditional extra paragraphs:
- If eGFR >= 45, from an eGFR no newer creatinine has outdated (US-07 AC8, section 1): potassium recommendation
- If the weight-medication trigger is on (section 6): weight loss + GLP-1 mention (the GLP-1 sentence only for a known age of 18 or over; US-07 AC6)

### Positions With No Card (Brad 2026-11-02)

- **Aspirin:** for secondary prevention only. After a heart attack, stroke or stent, aspirin is taken as your doctor directs; it is not for preventing a first event. The plan has no input for a past heart attack or stroke and no aspirin card.
- **No risk calculator or coronary calcium (CAC) score:** Brad: "I don't see the value. Just maximally control the cardiovascular risk factors". The plan treats each risk factor to its own target and records no calculated risk or CAC score.

`evidence.ts` has nothing to change for these (no card); `roadmap_text.html` states both in its cholesterol section.

---

## 4b. Dietary Interventions for Elevated Lipids (`lipid-diet`)

Source: `suggestions.ts` (nutrition section) + `evidence.ts`

### Trigger

Any atherogenic marker at or above its optimal line (each marker checked on its own, not through the hierarchy):
- ApoB ≥ 0.5 g/L (50 mg/dL), OR
- Non-HDL ≥ 1.6 mmol/L (62 mg/dL), OR
- LDL-C ≥ 1.4 mmol/L (55 mg/dL)

**NOT suppressed by medication cascade** — diet is always complementary to medications.

### Universal Foods (IBS/IBD-safe, low-FODMAP at recommended amounts)

| Food | Mechanism | Expected LDL Reduction |
|------|-----------|----------------------|
| Oats | Beta-glucan binds bile acids | 5–10% (3g/day beta-glucan ≈ 75g dry oats) |
| Walnuts | Unsaturated fats, ALA omega-3 | 3–7% (~40g/day) |
| Almonds | Unsaturated fats, plant sterols | 3–5% (~45g/day) |
| Ground flaxseed | Soluble fibre + ALA omega-3 | About 4–5% for ground or whole seed (~30g/day): pooled whole-flaxseed trials lowered LDL by 0.16 mmol/L (Pan 2009), about 4–5% of a typical LDL; pooling all forms, including oil, gives less (4.2 mg/dL, Hadi 2020) |
| Edamame | Soy protein replacing animal protein | 3–5% |
| Extra-virgin olive oil | Monounsaturated fat replacing butter/saturated fat | Modest direct LDL effect |

### Additional Options (no IBS/IBD)

Beans, lentils, chickpeas, and mixed vegetables — high in soluble fibre but also high-FODMAP, so not recommended for IBS/IBD patients.

### Supplement

**Psyllium husk** (about 10 g/day of husk, about 7 g of soluble fibre, the FDA health-claim amount): lowers LDL by about 0.33 mmol/L (13 mg/dL) in a meta-analysis of 28 trials at a median 10.2 g/day (Jovanovski 2018); the effect rises with dose (Wei 2009). Soluble, gel-forming, minimally fermented. ACG-recommended for IBS (both IBS-C and IBS-D). Well-tolerated in IBD remission.

### Key References

- Jenkins 2011 — Portfolio Diet (JAMA): [10.1001/jama.2011.1202](https://doi.org/10.1001/jama.2011.1202)
- Sabaté 2010 — Nut consumption and lipids (Arch Intern Med): [10.1001/archinternmed.2010.79](https://doi.org/10.1001/archinternmed.2010.79)
- Wei 2009 — Psyllium and cholesterol (Eur J Clin Nutr): [10.1038/ejcn.2008.49](https://doi.org/10.1038/ejcn.2008.49)
- Jovanovski 2018 — Psyllium, LDL, non-HDL and apoB meta-analysis (Am J Clin Nutr): [10.1093/ajcn/nqy115](https://doi.org/10.1093/ajcn/nqy115)
- Pan 2009 — Flaxseed and blood lipids meta-analysis (Am J Clin Nutr): [10.3945/ajcn.2009.27469](https://doi.org/10.3945/ajcn.2009.27469)
- Hadi 2020 — Flaxseed and lipid profile, 62 RCTs (Pharmacol Res): [10.1016/j.phrs.2019.104622](https://doi.org/10.1016/j.phrs.2019.104622)
- FDA 21 CFR 101.81 — health claim: 7 g or more a day of soluble fibre from psyllium seed husk

---

## 5. Cholesterol Medication Cascade

Source: `suggestions.ts` (lipids section) + `medication-cascades.ts` (`lipidCascade`, the step decisions) + `types.ts` (statin helpers)

### Trigger

Both conditions must hold:
1. `medications` object is provided (user is tracking medications)
2. The plan's lipid marker (ApoB, else non-HDL, else LDL) is at or above its on-treatment target:
   - ApoB >= 0.5 g/L, OR
   - Non-HDL >= 1.6 mmol/L, OR
   - LDL >= 1.4 mmol/L

### Step 1: Start Statin (`med-statin`)

**Condition:** Statin is null, undefined, `'none'`, or has an invalid drug name (handles old tier-based migration data).

**Card text** (after the lipid reason sentence): "Discuss starting a statin (e.g. Rosuvastatin 5mg) with your doctor. Don't start a statin if you are pregnant or planning a pregnancy." (US-07 AC14, Brad 2026-11-02: "no statins in pregnancy"; wording Brad 2026-11-09.) The cards for someone already on a statin (`med-statin-dose`, `med-statin-increase`, `med-statin-switch`) end: "If you become pregnant, most people should stop their statin: talk to your doctor. If you are planning a pregnancy, NICE advises stopping 3 months before trying to conceive." On a listed statin, the `med-ezetimibe` and `med-pcsk9i` cards end with the same line, after their own pregnancy line (Brad 2026-11-09); with the statin not tolerated they do not carry it. The reason adds: "The FDA advises most people to stop a statin once they know they are pregnant, and NICE advises stopping 3 months before trying to conceive." The categorical "Statins are not used in pregnancy" was dropped on 2026-11-09: the FDA removed the contraindication. Sources: FDA Drug Safety Communication, 20 July 2021 (it asked for the contraindication in all pregnant patients to be removed, but "most patients should stop statins once they learn they are pregnant"); NICE NG238 recommendation 1.5.10 (verified 2026-11-09: stop 3 months before attempting to conceive).

**Pregnancy, other lipid drugs (Brad 2026-11-09, from each drug's US label, section 8.1, DailyMed):** the `med-pcsk9i` and `med-ezetimibe` cards end "Not studied enough in pregnancy: talk to your doctor if you are pregnant or planning to be.": the Repatha (evolocumab), Praluent (alirocumab) and Zetia (ezetimibe) labels say only that the data are insufficient to evaluate a drug-associated risk. The `med-bempedoic-acid` card ends "Not recommended in pregnancy; talk to your doctor if you are pregnant or planning to be.": the Nexletol label says to discontinue it when pregnancy is recognized unless the benefits outweigh the potential risks to the fetus. Each reason says the same and cites its label; the bempedoic acid reason keeps the label's hedge: "unless the benefits outweigh the possible risks to the baby".

**Muscle damage (Brad 2026-11-02):** "statin muscle damage is rare but it does happen. if it does happen, switch to PCSK9i". The person records the statin as not tolerated, and the plan moves to the PCSK9 inhibitor (the statin-intolerant path below). The `med-pcsk9i` reason says: "Statin muscle damage is rare, but if it happens, stop the statin and move to a PCSK9 inhibitor."

### Step 2: Add Ezetimibe (`med-ezetimibe`)

**Condition:** On a listed statin AND ezetimibe is `undefined`, `'no'`, or `'not_yet'`. With the statin not tolerated, ezetimibe comes after the PCSK9 inhibitor instead (below).

### Step 3: Statin Escalation (`med-statin-increase` or `med-statin-switch`)

**Condition:** Ezetimibe handled (yes or not tolerated) AND statin tolerated AND escalation gate `statinEscalation` is `undefined` or `'not_yet'`.

- `canIncreaseDose(drug, dose)`: Higher dose available for current statin
- `shouldSuggestSwitch(drug, dose)`: On max dose of current statin, potency > 0, potency < 63%
- A dose not on the list is graded as the drug's nearest listed dose, the lower on a tie, so a step up is never skipped (`gradedDose`, US-06 AC10, Brad 2026-09-28). Rosuvastatin 2.5 mg grades as 5 mg (increase); atorvastatin 30 mg as 20 mg (increase); simvastatin 80 mg as 40 mg, its highest (switch).
- The switch card reads "You're at or near the maximum dose of {statin}": a dose graded up to the highest (AC10) may sit just below it, such as atorvastatin 70 mg.

**No dose recorded (`med-statin-dose`, US-06 AC8, Brad 2026-09-28):** on a listed statin whose dose is not recorded, the next step depends on the dose, so once ezetimibe is handled the plan asks for it. The dose card takes the slot the escalation or PCSK9 inhibitor card would have taken, whatever `statinEscalation` or `pcsk9i` says. Before ezetimibe is handled nothing changes. Title "Add your statin dose"; text, after the lipid reason sentence: "Your statin dose isn't recorded, and your next step depends on it. A higher dose or a more potent statin may help. Add your current dose to see which." On rosuvastatin, whose highest dose moves on to the PCSK9 inhibitor, the middle sentence reads "A higher dose may help, or you may already take the highest." Each card names only the steps its drug can take next.

### Step 4: PCSK9 Inhibitor (`med-pcsk9i`)

**Condition:** On a statin: ezetimibe handled, statin dose recorded AND statin escalation not tolerated, or already at max potency, or no escalation possible. In both, pcsk9i is `undefined`, `'no'`, or `'not_yet'`: on a statin, a `'no'` re-suggests it. Statin not tolerated: straight after the statin step, while pcsk9i is `undefined` or `'not_yet'`; taken, declined (`'no'`) or not tolerated moves on to ezetimibe (below).

**Note:** On a statin, when every step is answered and the marker is still at or above its target, the plan shows no further card. Brad decided not to flag it (2026-09-28): "there's nothing else that clinically can be done if taking statin, ezetimibe, and PCSK9i" (US-06 AC9). Bempedoic acid is never suggested to someone on a statin.

### Statin Not Tolerated: PCSK9 Inhibitor, Then Ezetimibe (US-06 AC20, Brad 2026-11-02)

When the statin is recorded as `'not_tolerated'`, the order is PCSK9 inhibitor → ezetimibe → bempedoic acid, each only while the marker is still at or above its target (the cascade's trigger):

1. `med-pcsk9i` while pcsk9i is `undefined` or `'not_yet'`, whatever ezetimibe says.
2. `med-ezetimibe` once the PCSK9 inhibitor is answered any way but `'not_yet'` (taken, `'no'` or `'not_tolerated'`) AND ezetimibe is `undefined` or `'not_yet'`. Brad: "Ezetimibe doesn't have evidence as a sole agent (to my knowledge)". The one outcome trial of ezetimibe alone found is EWTOPIA 75 (Ouchi 2019, Circulation, DOI: 10.1161/CIRCULATIONAHA.118.039415): an open-label trial of 3,796 Japanese adults aged 75 or over with raised LDL-C and no coronary disease, in which ezetimibe 10 mg lowered a composite of sudden cardiac death, heart attack, coronary revascularisation or stroke against usual care (HR 0.66, 95% CI 0.50-0.86); its authors advise caution over the size of the benefit, given the open-label design, early stop and follow-up problems. Recorded here only; it changes no card.
3. Step 5, bempedoic acid, below.

**Declined or not tolerated moves on (interim default 2026-11-02; Brad confirmed the wording 2026-11-09):** a PCSK9 inhibitor declined (`'no'`) or `'not_tolerated'` moves on to ezetimibe, and ezetimibe declined (`'no'`) or `'not_tolerated'` moves on to bempedoic acid (Brad 2026-11-09; until then an ezetimibe `'no'` re-suggested ezetimibe). Bempedoic acid has its own outcome data in people who cannot take statins (CLEAR Outcomes). With the statin not tolerated, `'no'` therefore ends the PCSK9 and ezetimibe steps; on a statin it still re-suggests them. The `med-pcsk9i` reason says: "If a statin is not tolerated for any reason, this plan suggests a PCSK9 inhibitor next. If your level is still above target after that step (taken, declined or not tolerated), ezetimibe comes next; bempedoic acid last." The form steps through the same order (statin, PCSK9 inhibitor, ezetimibe, bempedoic acid; US-06 AC5); a step that holds a recorded value always shows. Existing records keep their answers: no migration.

### Step 5: Bempedoic Acid (`med-bempedoic-acid`, US-06 AC20)

**Condition:** Statin `'not_tolerated'` AND pcsk9i answered any way but `'not_yet'` AND ezetimibe answered any way but `'not_yet'` (taken, `'no'` or `'not_tolerated'`; see above) AND bempedoic acid is `undefined`, `'not_yet'` or `'none'`, with the marker still at or above its target. Brad 2026-11-02: "maybe if PCSK9i + Ezetimibe isn't enough to get ApoB below 50? then add bempedoic acid (would only be used if statin intolerant)". The rule above extends this to a declined or not-tolerated PCSK9 inhibitor or ezetimibe. Never on a statin. Card text: "Bempedoic acid (Nexletol) lowers cholesterol via a different pathway than statins. Discuss with your doctor. Not recommended in pregnancy; talk to your doctor if you are pregnant or planning to be." Reason: CLEAR Outcomes (Nissen 2023, N Engl J Med 388:1353-1364, DOI: 10.1056/NEJMoa2215024, PMID 36876740), 13% fewer major adverse cardiovascular events in statin-intolerant patients; "This plan suggests it only if you cannot take a statin and your level is still above target after the PCSK9 inhibitor and ezetimibe steps (each taken, declined or not tolerated)." The form's hint: "Bempedoic acid lowers cholesterol production via a different pathway than statins. It is an option when a statin is not tolerated."

Until 2026-11-02 the plan suggested bempedoic acid to everyone right after ezetimibe, alongside the statin step-up.

### The input form (both cascades, US-06 AC5 and AC7)

The form's medication sections step through the same `lipidCascade` and `weightCascade` decisions as the cards. Progressive disclosure opens only the next empty step: a step that holds a recorded value always shows. Changing a drug or its dose may reset only that drug's own escalation answer, since the question depends on the dose (adding a missing dose resets it too). A chat edit that changes the statin or the GLP-1, the drug or its dose, resets that answer too, whether or not the cascade is showing; an answer stated in the same reply wins, and the chat's Undo restores every medication row the reply changed, a key that had no row going back to its unanswered value (US-06 AC12). An escalation answer is not a medication, so it records no history event, draws no chart pin and schedules no medication review (`isEscalationKey`, US-06 AC11); it never writes another medication (a GLP-1 dose change once wrote "not taking" rows for an SGLT2 inhibitor and metformin the person still took, and rows are permanent). A dose never recorded reads "Add dose" (it read "Dose not recorded" until 2026-09-28, which a 390 px phone cut to "Dose not re"), and while the plan asks for it (`med-statin-dose`, `weight-med-glp1-dose`) the hint under the drug's label reads "Add your dose: your next step depends on it." in place of the drug's description. A recorded value the form has no option for (a legacy `tier_1`, a raw `ezetimibe` row, an agent's escalation `yes`) reads "Other (recorded)".

### Statin Potency Table (BPAC 2021)

| Drug | Dose -> % LDL Reduction |
|------|------------------------|
| rosuvastatin | 5mg: 40%, 10mg: 47%, 20mg: 55%, 40mg: 63% |
| atorvastatin | 10mg: 30%, 20mg: 40%, 40mg: 47%, 80mg: 55% |
| simvastatin | 10mg: 30%, 20mg: 35%, 40mg: 40% |
| pravastatin | 20mg: 30%, 40mg: 40% |
| pitavastatin | 1mg: 30%, 2mg: 35%, 4mg: 40% |

**Max potency:** 63% (rosuvastatin 40mg).

### Statin Approach (for educational questions)

When discussing statins in educational contexts (not personalized cascade suggestions), apply this approach:

**Preferred starting options (low-dose hydrophilic statins):**
- Pravastatin 20mg — a preferred low-dose option; water-soluble, lower muscle-side-effect risk
- Rosuvastatin 5mg — also water-soluble at low dose; strong LDL reduction per mg
- Pitavastatin 1–2mg — well-tolerated hydrophilic option; similar potency profile to pravastatin

**Why low-dose + ezetimibe over high-dose monotherapy:**
Low-dose statins (~30–40% LDL reduction) combined with ezetimibe 10mg (~20% additional reduction) achieve better outcomes with fewer side effects than high-dose statin alone. Combination therapy is the recommended approach before escalating statin dose.

**Escalation order:** low-dose statin → add ezetimibe → escalate statin dose → PCSK9 inhibitor. Never skip ezetimibe to go straight to high-dose. If a statin is not tolerated (muscle damage included): PCSK9 inhibitor → ezetimibe → bempedoic acid (section 5).

Atorvastatin and simvastatin are fat-soluble; higher doses carry more myopathy risk. Reserve these for cases where hydrophilic statins are unavailable or ineffective.

---

## 6. Weight & Diabetes Medication Cascade

Source: `suggestions.ts` (`weightMedicationTrigger`, weight section) + `medication-cascades.ts` (`weightCascade`, the step decisions) + `types.ts` (GLP-1 helpers)

### Trigger (`weightMedicationTrigger`)

On when either holds:
1. BMI >= 25 AND at least one raised marker, OR
2. BMI classified as elevated (`bmiCategory` is Overweight or Obese after the WHtR reclassification) AND BMI > 28.

So: BMI >= 30 is always on; 28 < BMI < 30 is on unless the waist is healthy and no marker is raised; 25 <= BMI <= 28 needs a marker; BMI < 25 is always off. BMI is the rounded value the tile shows.

Raised markers, each named in the card in the plan's words:
- HbA1c >= 38.8 mmol/mol (prediabetic) → "prediabetic HbA1c"; at or above the diabetic line, 47.5 mmol/mol (6.5%), the urgent card's, → "diabetic-range HbA1c" (Brad 2026-11-06)
- Triglycerides 150 mg/dL (about 1.7 mmol/L) or more → "elevated triglycerides"
- Raised blood pressure: systolic >= 130 OR diastolic >= 80, either half on its own (section 3) → "elevated blood pressure"
- The plan's lipid marker (ApoB, else non-HDL, else LDL: `lipidMarkerFor`) at or above its risk-enhancing line → "elevated ApoB", "elevated non-HDL cholesterol" or "elevated LDL cholesterol":
  - ApoB >= 1.3 g/L (130 mg/dL)
  - Non-HDL >= 190 mg/dL (4.913 mmol/L), compared unrounded (section 1)
  - LDL-C >= 160 mg/dL (4.138 mmol/L)
- Waist-to-height >= 0.5 → "elevated waist-to-height ratio"

The cholesterol lines are the lower bounds of the risk-enhancing factors in the 2018 AHA/ACC/AACVPR/AAPA/ABC/ACPM/ADA/AGS/APhA/ASPC/NLA/PCNA Guideline on the Management of Blood Cholesterol (Grundy et al., Circulation 2019;139:e1082–e1143, DOI: 10.1161/CIR.0000000000000625), Table 6: primary hypercholesterolemia (LDL-C 160–189 mg/dL; non-HDL-C 190–219 mg/dL) and elevated apoB (>= 130 mg/dL). The trigger counts every value at or above the lower bound.

**Note:** a healthy waist-to-height ratio (< 0.5) no longer blocks a raised marker. It reclassifies BMI 25–29.9 as Normal, which only stops BMI 28–29.9 turning the trigger on by itself.

**Beyond the guidelines (Brad, 2026-09-26):** guidelines consider weight-loss medication at BMI > 30, or > 27 with a weight-related condition, after 3–6 months of lifestyle change. This plan is more proactive: from BMI 25 with a raised marker, and with no waiting period, alongside diet, exercise and sleep. No guideline supports the lower BMI lines.

The same trigger drives the cascade (medications tracked), the standalone `weight-glp1` card (medications not tracked), the BP cards' weight paragraph, and the input form's weight section, which steps through the cascade as section 5's form rules say.

### Step 1: Start GLP-1 (`weight-med-glp1`)

**Condition:** GLP-1 is null, undefined, or drug is `'none'`.

**Title:** "Consider discussing a GLP-1 medication with your doctor" (Brad 2026-11-13, US-25 AC28; it read "Consider a GLP-1 medication").

**Text:** "With a BMI of {bmi}{ and {reasons}}, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, alongside diet, exercise and sleep. These medications support weight management and metabolic health." The reasons join as "a, b and c".

### Step 2: GLP-1 Escalation (`weight-med-glp1-increase` or `weight-med-glp1-switch`)

**Condition:** On a GLP-1 (or on 'other') AND escalation gate `glp1Escalation` is `undefined` or `'not_yet'`.

- `canIncreaseGlp1Dose(drug, dose)`: Higher dose available for current drug
- `shouldSuggestGlp1Switch(drug, dose)`: On `'other'`, OR on max dose of non-tirzepatide GLP-1
- A dose not on the list is graded as the drug's nearest listed dose, the lower on a tie, so a step up is never skipped (`gradedDose`, US-06 AC10, Brad 2026-09-28). Semaglutide injection 2.0 mg grades as 1.7 mg (increase). An unlisted drug name has no list, so its switch card stays.

**No dose recorded (`weight-med-glp1-dose`, US-06 AC8, Brad 2026-09-28):** on a listed GLP-1 (tirzepatide, semaglutide injection or oral, dulaglutide) whose dose is not recorded, the next step depends on the dose, so the plan asks for it, whatever `glp1Escalation` says, and holds the later steps. `'other'` keeps its switch card, and an unlisted name, which the form cannot give a dose, moves on as before. Title "Add your GLP-1 dose"; text: "Your GLP-1 dose isn't recorded, and your next step depends on it. A higher dose or a switch to Tirzepatide may help. Add your current dose to see which." On tirzepatide, whose highest dose moves on to the SGLT2 inhibitor, the middle sentence reads "A higher dose may help, or you may already take the highest."

### Step 3: SGLT2i (`weight-med-sglt2i`)

**Condition:** GLP-1 dose recorded (when listed) AND GLP-1 escalation handled or not possible AND sglt2i is null, undefined, or drug is `'none'`.

**Evidence (US-07 AC9, Brad 2026-11-02, issue 473):** the card offers the drug through the proactive weight trigger above, a deliberate choice; its claim of proven cardiovascular and kidney protection is population-specific ("in some populations"). References: EMPA-REG OUTCOME (Zinman 2015), DAPA-HF (McMurray 2019), DAPA-CKD (Heerspink 2020), the five-trial heart failure meta-analysis (Vaduganathan 2022) and SMART-C (Neuen 2025).

### Step 4: Metformin (`weight-med-metformin`)

**Condition:** SGLT2i handled (on one or not tolerated) AND metformin is `undefined` or `'none'`.

### Standalone GLP-1 Suggestion (`weight-glp1`)

When medications are not tracked, one card replaces the cascade. It shows when the same trigger is on, with the same text as Step 1, built by one function. Title: "Weight management medication". A missing waist is not assumed to be raised: BMI 25–28 with no waist and no marker shows no card, and the plan prompts for a waist measurement instead.

---

## 7. Drug Configurations

Source: `types.ts`

### Statins

| Drug | Doses (mg) |
|------|-----------|
| atorvastatin | 10, 20, 40, 80 |
| pitavastatin | 1, 2, 4 |
| pravastatin | 20, 40 |
| rosuvastatin | 5, 10, 20, 40 |
| simvastatin | 10, 20, 40 (80mg excluded — myopathy risk) |

Status options: `'none'` (haven't tried), actual drug name, `'not_tolerated'`.

### Ezetimibe

Options: `'not_yet'`, `'yes'`, `'no'`, `'not_tolerated'`.

### PCSK9 Inhibitors

Options: `'not_yet'`, `'yes'`, `'no'`, `'not_tolerated'`.

### GLP-1 Receptor Agonists

| Drug | Doses (mg) |
|------|-----------|
| tirzepatide | 2.5, 5, 7.5, 10, 12.5, 15 |
| semaglutide_injection | 0.25, 0.5, 1, 1.7, 2.4 |
| semaglutide_oral | 3, 7, 14 |
| dulaglutide | 0.75, 1.5, 3, 4.5 |

Additional options: `'none'`, `'other'`, `'not_tolerated'`.

**Max potency drug:** tirzepatide (switch target in escalation).

### SGLT2 Inhibitors

| Drug | Doses (mg) |
|------|-----------|
| empagliflozin | 10, 25 |
| dapagliflozin | 5, 10 |
| canagliflozin | 100, 300 |

Status options: `'none'`, actual drug name, `'not_tolerated'`.

### Metformin

Options: `'none'`, `'ir_500'` through `'ir_2000'`, `'xr_500'` through `'xr_2000'`, `'not_tolerated'`. IR = Immediate Release, XR = Extended Release.

---

## 8. Cancer Screening

Source: `suggestions.ts` (screening section) + `types.ts` (intervals/follow-up)

### Eligibility by Age & Sex

| Screening | Age | Sex | Extra Criteria |
|-----------|-----|-----|----------------|
| Colorectal | 35-75 | Both | 35-44: Dr Brad's recommendation (ACS starts at 45) |
| Breast | 40+ | Female | 40-44 optional (info), 45+ recommended (attention) |
| Cervical | 25-65 | Female | — |
| Lung | 50-80 | Both | Former/current smoker AND >= 20 pack-years (ACS 2023; no quit window) |
| Prostate | 45+ | Male | Shared decision |
| Endometrial | 45+ | Female | Abnormal bleeding = urgent |
| DEXA | Female >= 50, Male >= 70 | Both | — |

With no sex on record only the unsexed screenings (colorectal, lung) show (US-07 AC8).

Colorectal method by age (Brad 2026-11-12): Dr Brad's sequence is a FIT test every year until 55, then a colonoscopy every 10 years; the ACS treats them as equal options. The start card names the sequence by age (35-44, 45-54, 55-75). From 55 to 75, a person on `fit_annual` sees one more line on the FIT up-to-date and overdue cards, suggesting a colonoscopy. The FIT schedule and reminder are unchanged until the method changes.
The line is not shown when the recorded result is abnormal (Brad 2026-11-12).
After an abnormal result, once the colonoscopy is done, the person is on a colonoscopy schedule: the next is due at the interval the report gave, counted once from the colonoscopy date, or 3 years with none given (Dr Brad's recommendation). colorectalMethod is never rewritten; the person records the next colonoscopy by switching the method to Colonoscopy.
"The new abnormal result starts the follow-up again" (Brad 2026-11-12): while the last screening's month is later than the follow-up's date, the form asks the result again for that screening. When the abnormal result is written, the old follow-up answers (status, date, follow-up time) are cleared and the existing urgent 'Organize colonoscopy' card shows. A date write or an upload never reopens it; until the result is answered the plan reads the stored answers as they are. The same month, or a follow-up with no date, does not reopen it. No new words.

Lung: the plan does not ask when someone quit. Like the American Cancer Society's 2023 guideline, a former smoker with >= 20 pack-years stays eligible however long ago they quit (Brad 2026-11-03; US-07 AC1e).

Lung follow-up: once an abnormal low-dose CT is recorded, its follow-up stays in the plan and the reminders whatever the pack-years and past 80, so a later correction below 20, or turning 81, never drops it (Brad 2026-11-03; US-07 AC1f, AC1g). Routine eligibility is age 50-80 with >= 20 pack-years; the follow-up exception needs only age 50 or over, a former/current smoking history, a last CT date and the abnormal result. Outside routine eligibility (below 20 pack-years or past 80) only the follow-up's organize and scheduled states show, as the urgent "Organize ..." card or the "follow-up scheduled" card; once the follow-up is completed, dated or not, there is no card and no reminder, because resuming annual screening is routine screening. No start, routine overdue/up-to-date or post-follow-up card shows there. Its reminder runs while the organize or scheduled card shows and falls on the follow-up dates in section 11 (US-17 AC15): the last CT's month (already due) while the follow-up is to organize, 3 months after the last CT once it is scheduled, never later than the routine annual date, repeating every 90 days until the status changes. At 50-80 with >= 20 pack-years nothing changes: a completed follow-up gives the post-follow-up card and reminder, and a completed one with no date falls back to the routine card and reminder.

### Screening Intervals (months)

| Method Key | Months |
|-----------|--------|
| `fit_annual` | 12 |
| `colonoscopy_10yr` | 120 |
| `annual` (breast) | 12 |
| `biennial` (breast) | 24 |
| `hpv_every_5yr` | 60 |
| `pap_every_3yr` | 36 |
| `annual_ldct` | 12 |
| `will_screen`, PSA < 2.5 | 24 |
| `will_screen`, PSA 2.5 to < 4.0, or no PSA value | 12 |
| any answer, PSA >= 4.0 | 3 |
| `other` (fallback) | 12 |
| `dexa_normal` | 60 (5 years) |
| `dexa_osteopenia` | 24 (2 years) |
| `dexa_scan` (default) | 24 |

### Post-Follow-up Repeat Intervals (months)

After abnormal result + completed follow-up investigation:

| Key | Months | Scenario |
|-----|--------|----------|
| `colorectal` (all methods) | the report's interval, else 36 | Abnormal result -> colonoscopy -> the next colonoscopy at the interval the colonoscopy report gave (1-10 years, once), else 3 years: Dr Brad's recommendation (Brad 2026-11-12) |
| `breast_annual` | 12 | Resume annual |
| `breast_biennial` | 24 | Resume biennial |
| `cervical_hpv_every_5yr` | 12 | HPV+ -> colposcopy -> 1 year |
| `cervical_pap_every_3yr` | 12 | Abnormal Pap -> 1 year |
| `cervical_other` | 12 | Default 1 year |
| `lung_annual_ldct` | 12 | Resume annual LDCT |
| `dexa_dexa_scan` | 12 | Osteoporosis follow-up -> 1 year |

### Follow-up Logic

For abnormal results, the follow-up status progresses through:
1. `not_organized` -> **urgent**: organize follow-up
2. `scheduled` -> **info**: keep appointment
3. `completed` + follow-up date -> check post-follow-up interval for overdue/upcoming
4. Colorectal, completed with no follow-up date: the 'Add your colonoscopy date' card (attention); no reminder until the date is added (Brad 2026-11-12).
5. Colorectal, a last screening later (by month) than the follow-up date: the form asks the result again; once abnormal is written for it, back to step 1. "The old follow-up answers are cleared" by that result write alone (Brad 2026-11-12).

### Overdue Calculation

```
intervalMonths = SCREENING_INTERVALS[method] ?? 12
nextDue = new Date(year, month - 1 + intervalMonths)
overdue = now > nextDue
```

### Prostate-Specific

- PSA >= 4.0 ng/mL -> `screening-prostate-elevated` (attention), whatever the screening answer. While it shows, `screening-prostate` (the discussion card) does not (Brad 2026-11-12).
- `elected_not_to` -> no screening card; no PSA reminder while the newest PSA is below 4.0. A saved PSA of 4.0 or above still shows `screening-prostate-elevated` (Brad 2026-11-03), and from 3 months on `screening-prostate-repeat` and the `screening_prostate` reminder (Brad 2026-11-12); so does the 3-month rule held through a vague newer PSA (US-06 AC21 item 6, below).
- The next PSA follows the newest usable PSA (Brad 2026-11-12): 24 months below 2.5 ng/mL and 12 months from 2.5 for men who will screen (Dr Brad's suggestion, after earlier ACS guidance; the ACS guideline revised 2026-11-12 sets the interval by age and risk, not by PSA level); 3 months at 4.0 or above for every man, whatever his answer, until a newer PSA below 4.0 is saved (Dr Brad's suggestion; the ACS advises repeating a high PSA to confirm it, preferably 2 weeks to 3 months later). A man who declined screening sees `screening-prostate-repeat` ("Repeat PSA test") in place of the overdue card.
- A newer PSA printed as a limit that does not decide against 4.0 ("< 5", "<= 4.0") keeps the 3-month rule (Brad 2026-11-13): it holds while the newest PSA that decides is 4.0 or above, and the next PSA is due 3 months after the newest test. `screening-prostate-elevated` does not show, and `screening-prostate` (the discussion card) still shows for a man with no answer or `not_yet`, and `screening-prostate-upcoming` does not; `screening-prostate-repeat` reads "An earlier PSA was 4.0 or higher, and your latest result does not show it is below 4.0, so checking it again is about that result, not screening." in place of its "Your last PSA" sentence.
- Every surface takes that one fact, never its own slice of the record (Brad 2026-11-13): `raisedBefore`, "an earlier PSA was 4.0 or above", is worked out once in health-core from the full record (`planPsa`; for a chat, `buildMeasurementHistory` before its 24-point cap, and the chat mirror when it is written) and rides on the newest PSA point a chat sends. The chat's plan takes it as sent; no earlier PSA value or date is sent for it.
- Where the PSA comes from (US-06 AC14): the newest usable active `psa` row, its value and its day, a core lab row since US-66. Usable: a value in the PSA range (0 to 10,000 ng/mL) and a real day no later than the latest day anywhere on Earth (UTC+14), so a server in UTC still counts the person's today; a newer unusable row never hides an older usable one. On one day the later time wins, then the later `createdAt`, then the id (US-07 AC4). A PSA printed as a limit (US-12 AC20) is graded only when the limit decides against 4.0: "> 100" and ">= 4.0" are elevated (">= 4.0" since Brad 2026-11-12), and the card shows the limit as printed ("Your PSA of > 100.0 ng/mL ..."); "< 0.1" is not; "< 5" and "<= 4.0" leave it uncertain, so no elevated card. Its day still dates the next test. The old answers `prostate_psa_value` and `prostate_last_date` count only when there is no usable row or when they are newer by date, value and day together; an answer that gives only a month loses to a row from that month. The web plan, `computePlan`, the reminder schedule and the chat's plan all read it this way.
- While `screening-prostate-elevated` shows, or the 3-month rule holds through a vague newer PSA, `screening-prostate-upcoming` ("PSA test up to date") does not: beside a raised PSA it reads as all clear. `screening-prostate-overdue` and the `screening_prostate` reminder follow the PSA rows of the intervals table (US-06 AC17, Brad 2026-11-03).
- A PSA below 4.0 never prints as 4.0 (US-06 AC18, turned round with the 4.0 line, Brad 2026-11-12): where one decimal would print 4.0, a PSA below 4.0 prints two, rounded down (3.96 reads 3.96, not 4.0), on `get_plan` and the PSA field's line on the web and the iPhone (`formatGradedReading`). Any other PSA prints to one decimal, so 4.04 reads 4.0, which is raised. A limit prints as printed.
- A PSA typed in the prostate section (US-06 AC15) is saved as a `psa` row on the day picked beside it (a full date, today until changed; never after today), as every blood test is dated. That day is also the last PSA test for the due card and the reminder: no client asks for or writes `prostate_last_date` any more.

### DEXA-Specific

Result-based intervals:
- Normal -> 5 years (`dexa_normal`)
- Osteopenia -> 2 years (`dexa_osteopenia`)
- Osteoporosis -> uses follow-up pattern (post-follow-up = 12 months)
- Awaiting -> no action

---

## 9. Skin Health; Supplements (separate groups)

Source: `suggestions.ts`

### Skin Health (adults, like the whole plan)

| ID | Title | Key Details |
|----|-------|-------------|
| `skin-moisturizer` | Daily moisturizer with ceramides | Ceramides + nicotinamide (B3) |
| `skin-sunscreen` | Daily broad-spectrum sunscreen | SPF 50+. **Conventional/US:** CeraVe Mineral (zinc oxide, titanium dioxide). **SI/non-US:** Beauty of Joseon SPF50+ (chemical filters). |
| `skin-retinoid` | Topical retinoid | Adapalene 0.3% or tretinoin 0.05%, 2-3 nights/week. **Must not use during pregnancy.** Tretinoin needs a prescription (the card says to ask a doctor or pharmacist). |
| `skin-advanced` | Advanced skin treatments | Red light therapy, fractional laser, IPL, microneedling |

### Supplements (always shown)

Generic, evidence-based ingredient profiles only — **no product names, no commerce
links** (compliance: listing generic ingredients is protected health information;
naming/linking a branded product is advertising a therapeutic good).

**US overlay exception (US-61, Brad 2026-10-31).** The engine emits these generic
cards in every country, and runRoadmap, get_plan, the CLI and the chat context never
carry a product. The PDF never carries a product name, link or ownership line; it clones
the screen, so the US text below (which names no product) may appear. Only the screen (the Shopify web build and the iPhone app)
adds a product block (`us-products.ts`) for a known adult in the US: MicroVitamin+ on
the micronutrient base, creatine, collagen, lutein and zeaxanthin and TMG cards; Sleep
on the sleep card; none on omega-3 or fiber; one ownership line under the section. On
three cards the overlay also swaps in a US text, kept beside the generic one in maps
keyed by card id (`US_SUPPLEMENT_DESCRIPTIONS` in suggestions.ts,
`US_SUPPLEMENT_REFERENCES` in evidence.ts; the keys lost their `-us` suffix on
2026-11-01, a rename only, with no text changed), so no disease outcome sits beside a named
product: `supplement-micronutrient-base` drops the WHO 2026 dementia sentences and
reference (COSMOS and the vitamin K2 / warfarin sentence stay);
`supplement-creatine` keeps the strength and lean mass sentence and Kreider 2017
only; `supplement-lutein-zeaxanthin` keeps the macular pigment sentences and Wilson
2021 only (no AREDS outcome). Supplement cards carry no `reason`, so their "Why this
suggestion?" panel is the reference list alone, and the swapped US references cover it.

| ID | Title | Ingredients / notes | Evidence |
|----|-------|---------------------|----------|
| `supplement-micronutrient-base` | Micronutrient base | Methylated B-complex; vitamin D3 + K2; magnesium taurate; trace minerals (glycinate); lutein + zeaxanthin; TMG; lycopene | COSMOS meta-analysis of 3 cognition sub-studies, men 60+ and women 65+ (Vyas 2024): global cognition and episodic memory, about 2 years less cognitive ageing. Executive function improved in COSMOS-Mind only (Baker 2023), so it is not a headline claim. WHO 2026 dementia guideline recommends against B, E, omega-3 and multivitamin-mineral supplements to reduce the risk of cognitive decline and dementia without a diagnosed deficiency (strong recommendation, moderate certainty; stated reason: 'unexpected harmful effects that outweigh any potential benefits'); it validated its 2019 advice without reassessing supplements and did not cite COSMOS. Vitamin K2 caveat: in healthy volunteers on a vitamin K antagonist, MK-7 at 10–20 mcg/day lowered the INR to a clinically relevant degree in at least 40–60%, and 45 mcg/day lowered the group mean INR by about 40% (Theuwissen 2013). The authors concluded that MK-7 supplements should be avoided with VKA therapy. The card keeps the softer instruction: it asks anyone on warfarin (Coumadin, Marevan) or another vitamin K antagonist to check with their doctor or anticoagulation clinic before starting or stopping K2 |
| `supplement-creatine` | Creatine | Creatine monohydrate, 3–5 g/day | Strength/lean mass (Kreider 2017). Cognition: an interesting signal that creatine may help memory, another possible benefit (Brad 2026-11-02; it was 'clear and consistent', his judgement); formal reviews are mixed. Avgerinos 2018 (systematic review) and two meta-analyses (Prokopidis 2023; Xu 2024, 16 RCTs, 492 adults) reported better memory, but both meta-analyses pooled several non-independent tests per participant (Prokopidis authors' reply 2023; Citherlet 2026 commentary on Xu). The Prokopidis authors' reanalysis found no clear overall memory benefit (SMD 0.19, P = 0.15) except in older adults aged 66–76 (SMD 0.80). Xu 2024: no effect on overall cognition or executive function; GRADE certainty moderate for memory, low for attention and processing speed. EFSA 2024: cause-and-effect not established for any cognitive domain; a working-memory effect only at 20 g/day for 5–7 days, not at 2.2–14 g/day or 5 g/day for 6 weeks after a 5-day loading phase. Text only: the card is always shown and no rule or dose changed |
| `supplement-collagen` | Collagen peptides | Hydrolyzed collagen peptides; may improve skin hydration and elasticity | Skin hydration/elasticity meta-analysis (Batool 2026) |
| `supplement-lutein-zeaxanthin` | Lutein and zeaxanthin | The macular pigments. No disease claim in the card's own advice; the AREDS lines report the trials | Macular pigment optical density rises with L/Z supplements, more at higher doses (Wilson 2021, Adv Nutr: 46 studies, 3,189 adults with healthy eyes; +0.04 at 5 to <20 mg/day, +0.11 at ≥20 mg/day). AREDS (2001): a formula of vitamins C and E, beta-carotene and zinc slowed progression of macular degeneration in people with intermediate macular degeneration. AREDS2 (2013, JAMA): 10 mg lutein + 2 mg zeaxanthin worked as well as beta-carotene in that formula, without beta-carotene's excess lung cancers, mostly in former smokers. At 10 years, lung cancer OR 1.82 (95% CI 1.06 to 3.12) with beta-carotene and 1.15 (0.79 to 1.66, not significant) with lutein and zeaxanthin (AREDS2 Report 28, Chew 2022). Framing rule (Brad): never write that adding L/Z "did not significantly slow progression". Adults only, like every supplement card (US-61) |
| `supplement-tmg` | TMG (trimethylglycine) | Betaine. Card: "lowers blood homocysteine … Small trials suggest it may improve strength and power." | Homocysteine: meta-analysis of 5 RCTs in healthy adults, ≥4 g/day for 6–24 weeks, −1.23 µmol/L (McRae 2013). Strength and power: small trials with mixed results, much weaker than creatine's (Lee 2010; Pryor 2012, cycling sprint; Nobari 2021, young soccer players). Lipids: 6 RCTs at ≥4 g/day for 6–24 weeks, total cholesterol +0.34 mmol/L (95% CI 0.02 to 0.65), no significant effect on LDL, HDL or triglycerides; the authors say it "may moderately increase" it (Zawieja 2021, J Diet Suppl). Not on the card (Brad 2026-11-01: the card does not advocate those doses). The homocysteine-to-dementia link stays off the card. Adults only (US-61) |
| `supplement-omega3` | Omega-3 | EPA/DHA, up to 1 g/day combined | CV benefits (Bernasconi 2021). The cognitive benefit of B vitamins may depend on good omega-3 status: in one trial, VITACOG, B vitamins slowed brain atrophy only with good omega-3 status, which was measured, not randomised (Jernerén 2015, Oulhaj 2016). The Dutch FACIT trial found the reverse: 800 mcg/day folic acid improved global cognition and processing speed only with lower omega-3 (van Soest 2021; 791 adults aged 50–70 with raised homocysteine; post hoc). WHO 2026 guideline recommends against omega-3, B, E and multivitamin-mineral supplements to reduce the risk of cognitive decline and dementia without a diagnosed deficiency (strong recommendation, moderate certainty; stated reason: 'unexpected harmful effects that outweigh any potential benefits'); it validated its 2019 advice without reassessing supplements, did not consider the omega-3 analyses of VITACOG or FACIT, and does not address omega-3 for heart health. That everyone may reasonably consider up to 1 g/day is Dr Stanfield's judgement, not a trial finding: CV benefit may rise with dose, but so may atrial fibrillation risk: AF HR 1.49 in trials testing >1 g/day vs 1.12 at ≤1 g/day (Gencer 2021). The card asks people with AF or on a blood thinner to check with their doctor first. Text only: the card is always shown and no dose is recorded or checked |
| `supplement-sleep` | Sleep support | Low-dose melatonin; glycine; magnesium glycinate. Timing (3 to 4 hours before the person wants to fall asleep) appears in roadmap_text only; the card carries no timing | Melatonin may reduce sleep onset latency (Low 2020); a longer gap between dose and bedtime predicted faster sleep onset, and the authors suggest about 3 hours (Cruz-Sanabria 2024; pooled trials of other doses and forms, not 0.8 mg sustained-release) |

**The page's Supplements section (roadmap_text.html, Brad 2026-11-02)** is education text, not
a card, and may say more than the cards do. Its headings give the doses Brad takes. Beyond the
cards it reports: the homocysteine and Alzheimer's link (Yu 2020: trials that lowered homocysteine with B
vitamins promising but not conclusive, "more research is needed", and TMG not tested); the lutein AREDS lines, as on the generic card; a fiber
entry framed only as a gap in intake (Quagliani 2017), with no cholesterol or blood pressure
claim; glycine (Inagawa 2006, Yamadera 2007, Bannai 2012) and magnesium bisglycinate
(Schuster 2025) for sleep; hyaluronic acid. GlyNAC sits under "Worth watching". "Medications That I Take" adds tirzepatide (Krumholz 2024, SURMOUNT-1 blood pressure) and empagliflozin (EMPA-KIDNEY 2023; canagliflozin in the ITP, Miller 2020), each labelled off-label; no card covers them. No card,
rule or dose changes. `evidence.ts` gains only AREDS2 Report 28 on the lutein card, the
source for its "no lung cancer signal" (the 2013 paper compared beta-carotene with none).

---

## 10. Progressive Disclosure

Source: `mappings.ts` -> `computeFormStage(inputs, saved)` and `opensFullForm(stage, saved)`

The form is the onboarding (US-62 AC13, Brad 2026-10-31): the stage is the first answer the record lacks. Each answer saves as it lands (the weight when its field is left, one active row per day), so a reload resumes at the first missing answer. Every step is required; there is no Skip. The widget shows the stage, and the storefront chatbot embed stays muted below stage 4; both call the same function, the embed on the widget's saved copy (US-15 AC10).

`saved` is the newest saved row per metric. Its values fill the longitudinal fields the form leaves empty (`mergeLongitudinalInputs`), so a value typed in the form wins over the saved one.

A value opens a stage only when it is plausible: inside its SI validation range in `UNIT_DEFS` (height 50–250 cm, weight 20–300 kg). A half-typed "1" of "180" does not open the next stage. Sex counts only as male or female. The birth date counts once the plan would keep it: a year from 1900 to this year, alone (the plan reads January, as the iPhone does) or with a month 1–12 not in the future (`validateInputValue`, `birthInFuture`). The form asks month and year; a year alone passes the step.

| Stage | The record lacks | Asks (with the why-text under the question) | The plan then shows | Attention Glow |
|-------|------------------|---------------------------------------------|---------------------|----------------|
| 1 | a plausible `heightCm` or `weightKg`, typed or saved | Height and weight | (after it) the BMI tile | Height, then Weight |
| 2 | `sex` | Sex | (after it) ideal body weight and the protein target | Sex |
| 3 | a usable `birthYear` (and a usable `birthMonth` when one is given) | Birth month and year | (after it) the age-based plan | Birth month, year |
| 4 | nothing | The rest of the form: vitals, blood tests, medications, screening, bone density, supplements, alcohol | Everything; the chat and the embed unmute | None (Email for guests) |

A record holding more than the four answers opens the whole form at any stage (`opensFullForm`): any saved value but the weight (a blood test, a waist, a blood pressure), or a medication, screening, supplement, lab test or document. The missing profile questions are pinned at the top and glow; the chat and the embed still wait for stage 4. The widget keeps the highest stage reached on the record it shows: it only rises, so whatever was unlocked (the whole form included) stays open while a profile answer is edited (a height cleared to retype); an erase starts the onboarding again. The chats' muting follows the stage itself.

The plan needs only a height (US-07 AC8), so it computes from step 1; what needs sex or age waits for those answers. Children (B9): no new rule before the birth date; once it arrives, a known minor gets today's handling (`knownMinorOf`).

### Field Categories

**PREFILL_FIELDS** (auto-saved with debounce): `heightCm`, `sex`, `birthYear`, `birthMonth`, `alcohol` (US-60). `unitSystem` is also auto-saved but not in the array.

**LONGITUDINAL_FIELDS** (immutable time-series; the first-time fields, the onboarding's weight among them, save when left, 500 ms later; the matrices save on leaving the grid or "Save New Values"): `weightKg`, `waistCm`, `hba1c`, `creatinine`, `psa`, `apoB`, `ldlC`, `totalCholesterol`, `hdlC`, `triglycerides`, `systolicBp`, `diastolicBp`, `lpa`.

---

## 11. Reminder System

Source: `reminder-schedule.ts` (what is due, and when) and `reminders.ts` (categories, groups, cooldowns)

### Categories and Groups

| Group | Categories | Cooldown |
|-------|-----------|----------|
| screening (90 days) | `screening_colorectal`, `screening_breast`, `screening_cervical`, `screening_lung`, `screening_prostate`, `screening_dexa` | 90 days |
| blood_test (180 days) | `blood_test_lipids`, `blood_test_hba1c`, `blood_test_creatinine` | 180 days |
| medication_review (365 days) | `medication_review` | 365 days |

### Blood Test Staleness

Threshold: **12 months**. Only for metrics the user has previously tracked.

- **Lipids:** Most recent date among ldl, total_cholesterol, hdl, triglycerides, apob
- **HbA1c:** Last hba1c date
- **Creatinine:** Last creatinine date

### Medication Review

Triggers when ANY active medication (drug name not in `['none', 'not_yet', 'not_tolerated', 'no']`) has `updatedAt` older than 12 months. Returns a single aggregate reminder (not per-medication).

### Screening Reminders

Same eligibility criteria as the suggestion algorithm (section 8). Checks both initial screening overdue and post-follow-up overdue. Only triggers for screenings the user has started (not `'not_yet_started'`), except prostate: a PSA of 4.0 or above, or the 3-month rule held through a vague newer PSA (US-06 AC21 item 6), gives the `screening_prostate` reminder whatever the answer (Brad 2026-11-12).

**Follow-up reminders (US-17 AC15, Brad 2026-11-05).** After an abnormal result (osteoporosis for bone density) with a last screening date, the reminder follows the follow-up card and is never later than the routine date:
- Follow-up to organize (no status, or `not_organized`): due at the last screening's month, which has passed, so the next daily email carries it.
- Follow-up scheduled: a check-in due 3 months after the last screening date, to record the follow-up result. The date stays put once it has passed.
- Follow-up completed with a date: the post-follow-up interval, unchanged. Completed with no date: the routine date, unchanged. Colorectal is the exception: no reminder; the card asks for the date (Brad 2026-11-12).

Neither date depends on today's date, so it never moves. Organize and check-in reminders repeat every 90 days (the screening cooldown) until the status changes. The cooldown is per category and spans follow-up states, so the first organize email can wait up to 90 days after a routine send for the same screening, and a check-in can arrive up to 90 days after the organize email. This covers colorectal, breast, cervical, lung (with the AC1f and AC1g follow-up exception) and bone density. Prostate and endometrial have no follow-up states.

Only the label and date reach the server, and the labels stay plain, but the date reflects the follow-up state over time, as a completed follow-up's post-follow-up date already did, and the PSA reminder's interval (24, 12 or 3 months) reflects the PSA band. Every reminder email carries one line for all items: "If you have a follow-up to arrange or a result to record, open the Health Roadmap." The iPhone works its reminders out on the phone and never calls the reminder server: its in-app list names the card's follow-up ("Follow-up to organize: repeat colonoscopy", "Follow-up check-in: colposcopy"), and a follow-up notifies on the first morning the phone sees it, or on its due day if later, then every 90 days from that day.

### Missing Profile Fields

The schedule needs a birth year: without one it holds only the annual check-in floor. It does not need a sex (US-07 AC8): with no sex on record (or one that is not male or female) the blood-test, medication-review, colorectal and lung reminders run as usual, and only the sexed screenings (breast, cervical, prostate, bone density) drop out.

### Preference Filtering

`computeReminderSchedule()` leaves out the categories the user has turned off (`reminderPreferences` in the record).

---

## 12. Validation Ranges

Source: `units.ts` (UNIT_DEFS) + `validation.ts`

| Metric | SI Min | SI Max | Conv Min | Conv Max |
|--------|--------|--------|----------|----------|
| height | 50 cm | 250 cm | 20 in | 98 in |
| weight | 20 kg | 300 kg | 44 lbs | 661 lbs |
| waist | 40 cm | 200 cm | 16 in | 79 in |
| hba1c | 9 mmol/mol | 195 mmol/mol | 3% | 20% |
| ldl | above 0 mmol/L | 12.9 mmol/L | above 0 mg/dL | 500 mg/dL |
| hdl | above 0 mmol/L | 5.2 mmol/L | above 0 mg/dL | 200 mg/dL |
| total_cholesterol | above 0 mmol/L | 15 mmol/L | above 0 mg/dL | 580 mg/dL |
| triglycerides | above 0 mmol/L | 22.6 mmol/L | above 0 mg/dL | 2000 mg/dL |
| apob | above 0 g/L | 3 g/L | above 0 mg/dL | 300 mg/dL |
| creatinine | 10 umol/L | 2650 umol/L | 0.1 mg/dL | 30 mg/dL |
| systolic_bp | 60 mmHg | 250 mmHg | 60 mmHg | 250 mmHg |
| diastolic_bp | 40 mmHg | 150 mmHg | 40 mmHg | 150 mmHg |
| psa | 0 ng/mL | 10,000 ng/mL | 0 ng/mL | 10,000 ng/mL |
| lpa | 0 nmol/L | 750 nmol/L | 0 mg/dL | 300 mg/dL (= 750 / 2.5; EAS pairs 300 mg/dL with 750 nmol/L) |

"above 0" is an exclusive floor (US-03 AC7, Brad 2026-10-31; `minExclusive` in `units.ts`, `.gt(0)` in `validation.ts`): LDL, HDL, total cholesterol, triglycerides and ApoB refuse 0, because zero is not a real result for them, and take any positive value, however small (LDL about 0.2 mmol/L on a PCSK9 inhibitor, HDL near 0.05 in Tangier disease), so there is no clinical floor above zero. PSA and Lp(a) keep an inclusive 0: very low readings happen and are reported as such. A 0 stored before the rule is never changed; the plan leaves it out like any out-of-range value. The history matrix shows it with no status colour, and the chat gets no older value in its place: it reads as if none was entered. Every other bound is inclusive. Three-file sync: `evidence.ts` and `roadmap_text.html` do not change, because neither states input ranges.

Blood pressure pair (US-02 AC8, `record-edits.ts`): on any day, the active systolic_bp must be above the active diastolic_bp; a save that would leave systolic at or below diastolic is refused (`out-of-range`).

### Profile Validation

- `sex`: 1 (male) or 2 (female)
- `birthYear`: 1900 to current year
- `birthMonth`: 1-12
- `unitSystem`: 1 (SI) or 2 (conventional)
- `height`: 50-250 cm
- `alcohol`: `'none'` or `'drinks'`; absent or null is not answered (US-60). Any other value reads as not answered.

---

## 13. FHIR Medication Storage

Source: `types.ts`, `supabase.server.ts`

Medications stored with separate fields for drug identity and dosage (FHIR MedicationStatement):

| medication_key | drug_name | dose_value | dose_unit | Derived status |
|---------------|-----------|------------|-----------|---------------|
| statin | atorvastatin | 40 | mg | active |
| statin | none | NULL | NULL | not-taken |
| statin | not_tolerated | NULL | NULL | stopped |
| ezetimibe | not_yet | NULL | NULL | intended |

### Status Derivation

Automatic from `drug_name`:
- `'none'` -> `'not-taken'`
- `'not_tolerated'` -> `'stopped'`
- `'not_yet'` -> `'intended'`
- Any actual drug name -> `'active'`

### Medication Keys

`statin`, `ezetimibe`, `statin_escalation`, `pcsk9i`, `glp1`, `glp1_escalation`, `sglt2i`, `metformin`

### Database Encoding

- `sex`: 1 = male, 2 = female
- `unitSystem`: 1 = SI, 2 = conventional

### Unit System Detection

Auto-detected from browser locale. Countries using conventional: US, LR (Liberia), MM (Myanmar), and the US territories PR (Puerto Rico), VI (US Virgin Islands), GU (Guam), MP (Northern Mariana Islands) and AS (American Samoa) (US-05 AC5). Special en-US cross-check: if timezone is non-US (e.g. Pacific/Auckland), defaults to SI; the territories' own zones count as US.
