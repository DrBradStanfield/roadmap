# Health Roadmap Algorithm

Single source of truth for all health calculations, clinical thresholds, medication cascades, screening logic, and suggestion rules. The code in `packages/health-core/src/` implements this algorithm. Clinical evidence (patient-facing reasons, guideline citations, DOI references) for each suggestion is defined in `packages/health-core/src/evidence.ts` and attached automatically by `generateSuggestions()`. The user-facing `roadmap_text.html` must stay consistent with this document and `evidence.ts`.

`packages/health-core/src/metric-guides.ts` (`METRIC_GUIDES`, US-58) is display-only text, the "about this measure" guides in the iOS app: it may only restate thresholds and claims already in this document, `evidence.ts` and `roadmap_text.html`, plus standard prescribing facts Brad approved (side effects, how a drug works), the standard measuring and preparation tips he approved as a category on 2026-10-26, and the lines he restored that day (docs/drafts/metric-guides.md, "Brad's decisions (2026-10-26)"), and cites only `evidence.ts` references (its `GUIDE_REFERENCES` hold the roadmap_text.html citations no suggestion uses). A clinical change here that alters a guide's claim changes the guide too.

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

`IBW = 2.2 × BMI_target + 3.5 × BMI_target × (height_m − 1.5)` kg

Sex-specific target BMIs (based on mortality meta-analyses):
- **Male:** BMI target = 24 (optimal mortality range 23–26)
- **Female:** BMI target = 22 (optimal mortality range 20–23)
- **Minimum:** `max(result, 30)` kg
- Rounded to 1 decimal place

### Daily Protein Target

- **Normal:** `round(IBW * 1.2)` grams/day
- **CKD (eGFR < 45):** `round(IBW * 1.0)` grams/day

The CKD adjustment uses strict less-than: at exactly eGFR 45, the normal 1.2 multiplier applies.

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
| 25.0–29.9 | unknown | Overweight | The BMI tile shows no label; the plan prompts for a waist measurement |
| 30.0–34.9 | any | Obese (Class I) | — |
| 35.0–39.9 | any | Obese (Class II) | — |
| >= 40.0 | any | Obese (Class III) | — |

**Key principle:** BMI 25–29.9 with normal WHtR (< 0.5) and no raised marker does NOT trigger weight management suggestions. A raised marker does, even with a healthy waist (see section 6).

### Waist-to-Height Ratio

`waistCm / heightCm` — rounded to 2 decimal places first, then graded: a rounded ratio >= 0.5 indicates increased metabolic risk. Because of the rounding, the ratio counts as elevated from about 0.495 × height (about 88.1 cm at 178 cm). Exactly on that line, floating-point rounding decides which side a waist falls. The plan and the vitals matrix grade the waist by this one rule (`isWaistToHeightElevated`). The matrix's "Target: <X" prints the first waist, at the display step, that the plan grades elevated (`formatTargetLine`): at 178 cm, 88 cm (0.494) is healthy and 89 cm (0.500) elevated, so "<89 cm". The matrix is editable, so a saved waist shows its plain value, coloured by the plan's grade (section 5): 88.1 cm at 178 cm is healthy, and shows as 34.7 in beside "<34.7 in", coloured healthy. When BMI is 25–29.9 and waist data is missing, a "Measure your waist circumference" suggestion is shown.

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

### Lab catalogue conversions

Source: `packages/health-core/src/lab-catalog.ts` (`LAB_CONVERSIONS`, `canonicalLabValue`). Since US-21 phase 3, a lab test the catalogue knows is **stored** in its canonical SI unit, not in the unit the lab printed. A writer sends the number and the unit as printed; the record converts it once, on the write, and converts `referenceLow`/`referenceHigh` by the same factor.

Factor = the number a reported value is multiplied by to reach the canonical unit. Spellings are matched lower case, after `normalizeLabUnit` folds report and LLM spelling (`umol/L` → `µmol/L`, `mcg` → `µg`, `uL` → `µL`, `x 10e9/L` → `×10⁹/L`, `1.73m2` → `1.73m²`, `gm/dL` → `g/dL`, `Units/L` → `U/L`, `10^3/cmm`, `10^3/cumm`, `10^3/mm3` or `10^3/mm³` → `×10³/µL`, `10^6/mm3` or `10^6/mm³` → `×10⁶/µL`, `cells/uL`, `cells/cmm`, `cells/cumm`, `cells/mm3` or `cells/mm³` → `cells/µL`). A cubic millimetre is a microlitre, so these folds rescale nothing. `mm3` and `mm³` fold only after a slash: a bare `mm³` is a volume and is never folded. A factor of 1 is a different notation for the same scale, not a conversion.

A spelling this table does not carry for that test is **refused** — never rescaled by guess. The refusal names the canonical unit and every spelling the test accepts, and the website counts it as `lab_unit_refused`. Six things follow from that:

- **A count in cells/µL converts only as a whole number** (WBC, the five differentials, platelets). Cells are counted, so a decimal in the result or either reference bound, or (with both bounds printed) a result above a hundred times the high bound or, for WBC and platelets only, below a hundredth of the low bound, means the lab printed thousands under the wrong label: the row is refused, never rescaled. A decimal's refusal asks whether the report means ×10³/µL; a range mismatch's says the value and its printed range are on different scales. A result of 0 always passes (it reads the same on any scale), and the differentials get no low-side check because real counts sit near zero. A correction in cells/µL is checked the same way against the range the row already holds, read on the canonical scale (so a legacy row still stored as `K/uL` or `10^3/cmm` is checked too). No per-test minimum yet, so a mislabelled whole number can still land.
- **A value no human sample reaches is refused** (US-21 AC21, Brad 2026-10-20). A real sheet printed free testosterone as "nmol/L" when its number and range (163–473) were pmol/L, so the ×1000 conversion produced an impossible result that would have saved. The count check cannot catch this, because the value and its range are mislabelled together. Five tests reachable through a ×1000 upward conversion carry a ceiling in their canonical unit: `free_testosterone` 10,000 pmol/L, `free_testosterone_calculated` 10,000 pmol/L, `reverse_t3` 10,000 pmol/L, `c_peptide` 50,000 pmol/L, `reticulocytes` 2,000 ×10⁹/L. The check applies only to a row converted by a ×1000 prefix step (nmol/L to pmol/L, ×10¹²/L to ×10⁹/L): when its converted value, or its converted printed high bound, passes the ceiling, it is refused, never rescaled. A row printed in any other spelling (the canonical unit, pg/mL, ng/dL, ng/mL) is never refused by the ceiling, because a real result can pass it (free testosterone on heavy androgen use can exceed 10,000 pmol/L, printed as pmol/L or as pg/mL). Without a printed range, a prefix error that lands under the ceiling is not caught (a female free testosterone of 8 printed as nmol/L stores 8,000 pmol/L). The refusal's note names the test, the ceiling and the two units, never the number: "Free testosterone above 10,000 pmol/L is not a measured value, so the printed unit is probably wrong (nmol/L vs pmol/L). Check the report, then add it in pmol/L with + Add a blood test." Troponin has no ceiling: a real high troponin overlaps a mislabelled one. Load never deletes or rewrites a row, so a stored row above a ceiling is left as it is: a legacy printed row gets no `#si` child, and one an older build already converted stays.
- **A differential in % is refused.** It is a share of the white count, not a count, and is never multiplied out from the WBC. Its refusal says the record keeps the absolute count (×10⁹/L or cells/µL), so the person looks for that line on the same report.
- **Prolactin in ng/mL is refused on purpose.** The mIU/L factor is assay-dependent (about 21.2 for the WHO 3rd IS), so converting would invent precision the report does not have.
- **A test the catalogue does not know is stored exactly as reported**, with its printed unit. There is no SI definition to convert it to, and refusing it would throw the value away.
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
| `prolactin` | mIU/L | microiu/ml | 1 | µIU/mL with the prefix spelled out |
| `prolactin` | mIU/L | mciu/ml | 1 | µIU/mL with the mc prefix (as mcg) |
| `cortisol_am` | nmol/L | µg/dl | 27.59 | cortisol 362.46 g/mol |
| `psa_free` | µg/L | ng/ml | 1 | ng/mL and µg/L are the same number |
| `lh` | IU/L | miu/ml | 1 | mIU/mL and IU/L are the same number |
| `lh` | IU/L | u/l | 1 | U/L is IU/L, printed short |
| `fsh` | IU/L | miu/ml | 1 | mIU/mL and IU/L are the same number |
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

AC20 adds the comma, bracket and "absolute" spellings US, AU and NZ reports print for tests already catalogued ("Bilirubin, Total", "ALT (SGPT)", "Neutrophils (Absolute)"). There is no punctuation fold: each spelling is listed. "Urea Nitrogen (BUN)" takes BUN's mg/dL factor; "Urea (BUN)" does not (see the `urea` row). The extraction prompt is unchanged: it does not yet suggest the new keys, the new core names or `bun`; that prompt change waits for the #166 Haiku benchmark. What a US BUN in mg/dL does today depends on the name it arrives under. Under a printed nitrogen name ("BUN", "Urea Nitrogen", "Blood Urea Nitrogen (BUN)", or the extractor's `blood_urea_nitrogen`) it converts at ×0.357. Under "Urea (BUN)" or the bare `urea` it is refused. The assistant routes (`file_results`, `add_lab_values`) store the printed name, so they convert. The website stores the extractor's snake_case name, and the prompt still suggests only `urea` for a urea row, so a website BUN in mg/dL is still refused there. The core resolver (not the prompt) gained the printed names on Brad's own reports ("Cholesterol (HDL)", "Cholesterol (LDL) (calculated)") and six more ("HDL-Cholesterol", "LDL-Cholesterol", "LDL Chol Calc (NIH)", "Glycated haemoglobin (HbA1c)", "PSA, Total", "Prostate Specific Ag"). A direct LDL is not yet a core alias: which LDL wins a day with both is open (US-21 AC19 notes).

Three-file sync: `evidence.ts` and `roadmap_text.html` are untouched because no threshold, suggestion or user-facing sentence changes — only the unit a stored number is expressed in. This holds for the 2026-10-20 additions too: no suggestion reads a catalogued test (`suggestions.ts` never reads `labValues`), so they are record-keeping only. If any of them ever drives a suggestion, all three files change.

---

## 3. Clinical Thresholds

Source: `units.ts`

All thresholds stored and compared in SI canonical units.

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

### Triglycerides (mmol/L)

| Level | mmol/L | mg/dL |
|-------|--------|-------|
| Borderline | 1.69 | 150 |
| High | 2.26 | 200 |
| Very high | 5.64 | 500 |

### Blood Pressure (mmHg)

| Threshold | Systolic | Diastolic |
|-----------|----------|-----------|
| Elevated | 120 | — |
| Stage 1 | 130 | 80 |
| Stage 2 | 140 | 90 |
| Crisis | 180 | 120 |

**Raised blood pressure** means one thing everywhere (the `bp-stage1` card and the weight-medication trigger): systolic >= 130 OR diastolic > 80. Either half counts on its own; the stage cards still need both halves to show.

**Age-dependent target** (based on SPRINT 2015 + ESPRIT 2024; `bpTargetFor` in `units.ts`, which the stage 1 card, the low-salt card, the Lp(a) checklist and the form's BP targets all read):
- Age < 65: < 120/80
- Age >= 65: < 130/80

### eGFR (mL/min/1.73m^2)

| Constant | Value | Meaning |
|----------|-------|---------|
| lowNormal | 60 | eGFR 60-69, no CKD without markers |
| mildlyDecreased | 45 | CKD-3b boundary, protein adjustment |
| moderatelyDecreased | 30 | G3b |
| severelyDecreased | 15 | G4 |

### ApoB (g/L)

| Level | g/L | mg/dL |
|-------|-----|-------|
| Borderline | 0.5 | 50 |
| High | 0.7 | 70 |
| Very high | 1.0 | 100 |

### PSA (ng/mL)

Normal upper limit: 4.0 ng/mL.

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

Used when medications are tracked and a lipid is at or above its target: the value should be below it, so the target itself counts as above target (Brad, 2026-09-28). Cards and the form say "the treatment target is below X". Every "<X" statement of a lipid target (these cards, the borderline cards, the Lp(a) checklist and the reference hints) prints X as the first value, at the unit's display step, that the plan grades at or above the target (`formatTargetLine`): 0.50, 1.4 and 1.6 in SI; 50, 55 and 62 in mg/dL. 54 mg/dL of LDL is 1.396 mmol/L, which the plan grades below 1.4, so the mg/dL target reads 55. The LDL and non-HDL targets are also the tiles' Optimal line and the `lipid-diet` trigger, which use the same `>=` comparison. In the read-only summaries, a value printed beside its target (the cards' "Your LDL-c is…" sentence, the form's cholesterol intro, the Lp(a) checklist, the lipid tile and the MCP `get_plan` currentValues) shows on the side of X the plan grades it (`formatGradedValue`). It rounds to the display step as everywhere else, unless that would put it on the other side of X. Then a value graded at or above the target shows X, and a value graded below it shows one more decimal place, rounded down, which is always below X. So 1.40 mmol/L of LDL, at the target, shows as 55 mg/dL, not 54; 54 mg/dL (1.3964 mmol/L), below it, shows as 1.39 mmol/L, not 1.4; a non-HDL of 1.56 shows as 1.56. A value typed in the shown unit, on the display step, shows as typed. The history matrices (blood tests and vitals) are editable, so they show plain values, rounded to the display step: the number a typed value is compared against, so re-entering the shown number writes nothing (US-03 AC3). Their colour is the plan's grade. So a value within one display step of its line, entered in the other unit, can read on the other side of the hint there: 1.40 mmol/L of LDL shows as 54 mg/dL beside "<55", coloured above optimal.

| Marker | Target | Conventional |
|--------|--------|-------------|
| ApoB | < 0.5 g/L | < 50 mg/dL |
| LDL | < 1.4 mmol/L | < 55 mg/dL |
| Non-HDL | < 1.6 mmol/L | < 62 mg/dL |

ApoB source: Brad's target, extended from the Ez-PAVE LDL-C target trial (Lee 2026) and PESA (Ibanez 2021), and lower than the ESC/EAS 2019 goal of < 65 mg/dL for very high risk.

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

### Who the Plan Is For

The plan is built for adults aged 18 and over (US-07 AC6, 2026-10-14; amended the same day). Its thresholds, targets and medicines come from adult guidelines.

| Age | Plan |
|-----|------|
| Known and under 18 | No suggestions of any kind. One card in their place: `adults-only` (general, info), "This plan is built for adults": "The suggestions here, including medicines, are designed for people aged 18 and over. For anyone younger, talk with their doctor." |
| 18 or over | The plan below, unchanged. |
| Unknown (no birth year) | The plan below, except the medicine cards. Medicine cards need a known age of 18 or over. When the plan would show any, they give way to one card where the first stood: `add-birth-year` (general, info), "Add your birth year": "Medicine suggestions need your age. Add your birth year to see them." Every other card is unchanged. The standalone lipid cards (`apob-*`, `non-hdl-*`, `ldl-*`, `total-chol-*`) never give way to the lipid cascade here, because the cascade is not shown. No weight card gives way to the weight cascade, at any age. The kept cards suggest no medicine in their own text: `apob-very-high` ends "Discuss treatment, including lifestyle changes, with your doctor." and `ldl-very-high` "Discuss treatment with your doctor." in place of their statin sentence, `bp-stage2` says "Discuss treatment with your doctor." in place of "Medication is typically recommended at this level.", `bp-stage1` and `bp-stage2` keep their weight-loss sentences but leave out "GLP-1 medications (tirzepatide, semaglutide) can assist with both weight loss and blood pressure reduction.", and the `lpa-elevated` checklist leaves out its "not started" medicine lines. One exception, by decision: `ldl-high` keeps "Consider lifestyle modifications and discuss medication options." It names no medicine, and discussing is not suggesting. |

The medicine cards are the `medication` category: `weight-glp1`; `weight-med-glp1`, `-glp1-dose`, `-glp1-increase`, `-glp1-switch`, `-sglt2i`, `-metformin`; `med-statin`, `-ezetimibe`, `-bempedoic-acid`, `-statin-dose`, `-statin-increase`, `-statin-switch`, `-pcsk9i`.

The gate's age (`isKnownMinor`) is the one in section 1, except that a missing birth month is strict: the person is a minor until 1 January of the year after the year they turn 18 (birth year + 19), so no one counts as 18 early. Someone born in 2008 with no month is a minor through 31 December 2026 and an adult from 1 January 2027. A known month keeps the birthday-month rule. The gate reads the date at UTC−12, the zone furthest behind, whatever zone it runs in (the hosted server runs in UTC), so no one anywhere counts as 18 early: the new month or year starts for the gate at 12:00 UTC on its first day (born November 2008: an adult from 1 November 2026 12:00 UTC; born 2008 with no month: from 1 January 2027 12:00 UTC). Every other age keeps the January default and the local date, so that person's profile reads 18 beside the adults-only card through 2026 (accepted). Every surface (the plan, the reminder schedule, the form, the chat context) asks the gate over the birth year and month the plan keeps (`knownMinorOf`): one outside the plan's bounds (birth year 1900 to this year, month 1 to 12) counts as missing, so no surface calls someone a minor while the plan has no age for them.

For a known minor, every surface also withholds:

- **Adult readings.** The BMI category, ideal body weight, protein target and eGFR, and the status labels on the lipid, HbA1c and Lp(a) tiles, with the "why" behind each. The website tiles and the PDF show the raw numbers only (BMI, lipid marker, Lp(a), HbA1c); the ideal body weight, protein and eGFR tiles go. `get_plan` returns `bmiCategory`, `eGFR`, `idealBodyWeightKg` and `proteinTargetG` as `null`; the CLI prints the BMI with no category and no eGFR. Raw values (weight, height, waist, each lab value with its unit and date) are untouched.
- **The schedule.** `computeReminderSchedule` returns nothing, not even the annual check-in floor, so `get_plan`'s `due` is empty. The browser never enrols a known minor in reminders, never pushes their schedule (the server would add its annual check-in to any schedule it is sent), and turns off a row enrolled earlier with the widget's own cancel. That cancel is the age gate's, not the user's: it is permanent (at 18 they turn reminders on by hand) and is not counted as an opt-out.
- **The form's medicine wording.** The medication sections are plain fields with their neutral sentence: no recommendation, target sentence or step hint. People can still record what they take. The form does the same for an unknown age, because it follows the plan (US-06 AC5).
- **The form's adult targets.** The weight row's "Target: <ideal body weight>", the blood-pressure target and its status colours, and the reference hints and status colours of the blood-test matrix (saved values, the draft column and the correction editor) and the upload review matrix. The form reads the validated birth year and month alone, so this holds with no plan too (no height or sex). The values stay and stay editable, and no empty box is left. The waist line, its colour and the waist-to-height tile stay: the 0.5 ratio is also used in children.

Measurements, lab values and the record are untouched: they are still stored and shown. There is no usage signal: an event would record that a visitor is under 18.

**Reasons stay for every age.** A card's "Why this suggestion?" reason is keyed by its id and explains the guideline, so it does not change with age: `apob-very-high` still says statin therapy "is typically recommended" and `ldl-very-high` that guidelines "recommend statin therapy at this level". A reason does not suggest a medicine to this person; the card text does, and that is what changes for an unknown age.

Three-file sync for this section's 2026-10-14 amendments (the strict missing-month rule, the UTC−12 date, the lipid cards kept for an unknown age and their medicine-free text, the BP cards' GLP-1 sentence withheld for an unknown age, the form's and review's withheld readings):
- `evidence.ts`: no change. No card's reason, guideline tag or citation changed; the `adults-only` and `add-birth-year` reasons still hold.
- `roadmap_text.html`: no change. Its two sentences still hold: the plan "is built for adults aged 18 and over", and the medicines are suggested "only when your birth year shows you are 18 or over" (the strict rule and the UTC−12 date only make that later; with no birth year no card's text suggests one, and the reasons explain the guideline, as above).

### Always-Show Lifestyle Suggestions

| ID | Category | What | Evidence |
|----|----------|------|----------|
| `protein-target` | nutrition | Daily protein target (CKD-adjusted if eGFR < 45) | ISSN 2017 |
| `fiber` | nutrition | 25-35g fiber daily | Reynolds 2019 |
| `exercise` | exercise | At least 150 min moderate cardio, or 75 min vigorous, or a mix (1 vigorous min = 2 moderate) + 2-3 resistance sessions/week | WHO 2020; Physical Activity Guidelines 2018 |
| `sleep` | sleep | 7-9 hours nightly | Cappuccio 2010 |

### Conditional Lifestyle Suggestions

| ID | Condition | Priority | Notes |
|----|-----------|----------|-------|
| `low-salt` | systolicBp > 120 (age < 65) or > 130 (age >= 65) | info | Target: <1,500 mg/day (ACC/AHA 2017) |
| `high-potassium` | eGFR >= 45 (safe kidney function) | info | |
| `trig-nutrition` | triglycerides 150 mg/dL (about 1.7 mmol/L) or more | attention | |
| `reduce-alcohol` | BMI >= 30, OR (BMI > 25 AND WHtR >= 0.5), OR triglycerides 150 mg/dL (about 1.7 mmol/L) or more | attention | |

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
| `hdl-low` | HDL < sex-specific threshold | attention |
| `trig-very-high` | triglycerides >= 5.64 mmol/L (500 mg/dL) — pancreatitis risk | urgent |

### Blood Pressure Tiers

| ID | Condition | Priority |
|----|-----------|----------|
| `bp-crisis` | sys >= 180 OR dia >= 120 | urgent |
| `bp-stage2` | sys >= 140 OR dia >= 90 | urgent |
| `bp-stage1` | sys >= 130 OR dia > 80 | attention |

Stage 1 shows age-dependent target: < 120/80 for age < 65, < 130/80 for age >= 65.

Stage 1 and 2 include conditional extra paragraphs:
- If eGFR >= 45: potassium recommendation
- If the weight-medication trigger is on (section 6): weight loss + GLP-1 mention (the GLP-1 sentence only for a known age of 18 or over; US-07 AC6)

---

## 4b. Dietary Interventions for Elevated Lipids (`lipid-diet`)

Source: `suggestions.ts` (nutrition section) + `evidence.ts`

### Trigger

Any atherogenic marker at or above its optimal line (each marker checked on its own, not through the hierarchy):
- ApoB ≥ 0.5 g/L (50 mg/dL), OR
- Non-HDL ≥ 1.6 mmol/L (62 mg/dL), OR
- LDL-C ≥ 1.4 mmol/L (55 mg/dL)

**NOT suppressed by medication cascade** — diet is always complementary to medications.

When active, the generic `fiber` suggestion is suppressed (lipid-diet covers fibre advice more specifically).

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

### Step 2: Add Ezetimibe (`med-ezetimibe`)

**Condition:** On a statin (or statin not tolerated) AND ezetimibe is `undefined`, `'no'`, or `'not_yet'`.

### Step 3: Statin Escalation (`med-statin-increase` or `med-statin-switch`)

**Condition:** Ezetimibe handled (yes or not tolerated) AND statin tolerated AND escalation gate `statinEscalation` is `undefined` or `'not_yet'`.

- `canIncreaseDose(drug, dose)`: Higher dose available for current statin
- `shouldSuggestSwitch(drug, dose)`: On max dose of current statin, potency > 0, potency < 63%
- A dose not on the list is graded as the drug's nearest listed dose, the lower on a tie, so a step up is never skipped (`gradedDose`, US-06 AC10, Brad 2026-09-28). Rosuvastatin 2.5 mg grades as 5 mg (increase); atorvastatin 30 mg as 20 mg (increase); simvastatin 80 mg as 40 mg, its highest (switch).
- The switch card reads "You're at or near the maximum dose of {statin}": a dose graded up to the highest (AC10) may sit just below it, such as atorvastatin 70 mg.

**No dose recorded (`med-statin-dose`, US-06 AC8, Brad 2026-09-28):** on a listed statin whose dose is not recorded, the next step depends on the dose, so once ezetimibe is handled the plan asks for it. The dose card takes the slot the escalation or PCSK9 inhibitor card would have taken, whatever `statinEscalation` or `pcsk9i` says; bempedoic acid still shows first while unanswered. Before ezetimibe is handled nothing changes. Title "Add your statin dose"; text, after the lipid reason sentence: "Your statin dose isn't recorded, and your next step depends on it. A higher dose or a more potent statin may help. Add your current dose to see which." On rosuvastatin, whose highest dose moves on to the PCSK9 inhibitor, the middle sentence reads "A higher dose may help, or you may already take the highest." Each card names only the steps its drug can take next.

### Step 4: PCSK9 Inhibitor (`med-pcsk9i`)

**Condition:** Statin dose recorded (or statin not tolerated) AND statin escalation not tolerated, or already at max potency, or no escalation possible. AND pcsk9i is `undefined`, `'no'`, or `'not_yet'`.

**Note:** When every step is answered and the marker is still at or above its target, the plan shows no further card. Brad decided not to flag it (2026-09-28): "there's nothing else that clinically can be done if taking statin, ezetimibe, and PCSK9i" (US-06 AC9).

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

**Escalation order:** low-dose statin → add ezetimibe → escalate statin dose → PCSK9 inhibitor. Never skip ezetimibe to go straight to high-dose.

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
- HbA1c >= 38.8 mmol/mol (prediabetic) → "prediabetic HbA1c"
- Triglycerides 150 mg/dL (about 1.7 mmol/L) or more → "elevated triglycerides"
- Raised blood pressure: systolic >= 130 OR diastolic > 80, either half on its own (section 3) → "elevated blood pressure"
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

**Text:** "With a BMI of {bmi}{ and {reasons}}, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, alongside diet, exercise and sleep. These medications support weight management and metabolic health." The reasons join as "a, b and c".

### Step 2: GLP-1 Escalation (`weight-med-glp1-increase` or `weight-med-glp1-switch`)

**Condition:** On a GLP-1 (or on 'other') AND escalation gate `glp1Escalation` is `undefined` or `'not_yet'`.

- `canIncreaseGlp1Dose(drug, dose)`: Higher dose available for current drug
- `shouldSuggestGlp1Switch(drug, dose)`: On `'other'`, OR on max dose of non-tirzepatide GLP-1
- A dose not on the list is graded as the drug's nearest listed dose, the lower on a tie, so a step up is never skipped (`gradedDose`, US-06 AC10, Brad 2026-09-28). Semaglutide injection 2.0 mg grades as 1.7 mg (increase). An unlisted drug name has no list, so its switch card stays.

**No dose recorded (`weight-med-glp1-dose`, US-06 AC8, Brad 2026-09-28):** on a listed GLP-1 (tirzepatide, semaglutide injection or oral, dulaglutide) whose dose is not recorded, the next step depends on the dose, so the plan asks for it, whatever `glp1Escalation` says, and holds the later steps. `'other'` keeps its switch card, and an unlisted name, which the form cannot give a dose, moves on as before. Title "Add your GLP-1 dose"; text: "Your GLP-1 dose isn't recorded, and your next step depends on it. A higher dose or a switch to Tirzepatide may help. Add your current dose to see which." On tirzepatide, whose highest dose moves on to the SGLT2 inhibitor, the middle sentence reads "A higher dose may help, or you may already take the highest."

### Step 3: SGLT2i (`weight-med-sglt2i`)

**Condition:** GLP-1 dose recorded (when listed) AND GLP-1 escalation handled or not possible AND sglt2i is null, undefined, or drug is `'none'`.

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
| Colorectal | 35-75 | Both | — |
| Breast | 40+ | Female | 40-44 optional (info), 45+ recommended (attention) |
| Cervical | 25-65 | Female | — |
| Lung | 50-80 | Both | Former/current smoker AND >= 15 pack-years (USPSTF 2021) |
| Prostate | 45+ | Male | Shared decision |
| Endometrial | 45+ | Female | Abnormal bleeding = urgent |
| DEXA | Female >= 50, Male >= 70 | Both | — |

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
| `will_screen` (prostate PSA) | 12 |
| `other` (fallback) | 12 |
| `dexa_normal` | 60 (5 years) |
| `dexa_osteopenia` | 24 (2 years) |
| `dexa_scan` (default) | 24 |

### Post-Follow-up Repeat Intervals (months)

After abnormal result + completed follow-up investigation:

| Key | Months | Scenario |
|-----|--------|----------|
| `colorectal_fit_annual` | 36 | Positive FIT -> colonoscopy -> 3 years |
| `colorectal_colonoscopy_10yr` | 36 | Polyps found -> 3 years |
| `colorectal_other` | 36 | Default 3 years |
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

### Overdue Calculation

```
intervalMonths = SCREENING_INTERVALS[method] ?? 12
nextDue = new Date(year, month - 1 + intervalMonths)
overdue = now > nextDue
```

### Prostate-Specific

- PSA > 4.0 ng/mL -> `screening-prostate-elevated` (attention)
- `elected_not_to` -> no suggestion shown

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
| `skin-retinoid` | Topical retinoid | Adapalene 0.3% or tretinoin 0.05%, 2-3 nights/week. **Must not use during pregnancy.** |
| `skin-advanced` | Advanced skin treatments | Red light therapy, fractional laser, IPL, microneedling |

### Supplements (always shown)

Generic, evidence-based ingredient profiles only — **no product names, no commerce
links** (compliance: listing generic ingredients is protected health information;
naming/linking a branded product is advertising a therapeutic good).

| ID | Title | Ingredients / notes | Evidence |
|----|-------|---------------------|----------|
| `supplement-micronutrient-base` | Micronutrient base | Methylated B-complex; vitamin D3 + K2; magnesium taurate; trace minerals (glycinate); lutein + zeaxanthin; TMG; lycopene | COSMOS meta-analysis of 3 cognition sub-studies, men 60+ and women 65+ (Vyas 2024): global cognition and episodic memory, about 2 years less cognitive ageing. Executive function improved in COSMOS-Mind only (Baker 2023), so it is not a headline claim. WHO 2026 dementia guideline recommends against B, E, omega-3 and multivitamin-mineral supplements to reduce the risk of cognitive decline and dementia without a diagnosed deficiency (strong recommendation, moderate certainty; stated reason: 'unexpected harmful effects that outweigh any potential benefits'); it validated its 2019 advice without reassessing supplements and did not cite COSMOS. Vitamin K2 caveat: in healthy volunteers on a vitamin K antagonist, MK-7 at 10–20 mcg/day lowered the INR to a clinically relevant degree in at least 40–60%, and 45 mcg/day lowered the group mean INR by about 40% (Theuwissen 2013). The authors concluded that MK-7 supplements should be avoided with VKA therapy. The card keeps the softer instruction: it asks anyone on warfarin (Coumadin, Marevan) or another vitamin K antagonist to check with their doctor or anticoagulation clinic before starting or stopping K2 |
| `supplement-creatine` | Creatine | Creatine monohydrate, 3–5 g/day | Strength/lean mass (Kreider 2017). Cognition: that the memory evidence is clear and consistent is Dr Stanfield's judgement, not a trial finding; formal reviews are more mixed. Avgerinos 2018 (systematic review) and two meta-analyses (Prokopidis 2023; Xu 2024, 16 RCTs, 492 adults) reported better memory, but both meta-analyses pooled several non-independent tests per participant (Prokopidis authors' reply 2023; Citherlet 2026 commentary on Xu). The Prokopidis authors' reanalysis found no clear overall memory benefit (SMD 0.19, P = 0.15) except in older adults aged 66–76 (SMD 0.80). Xu 2024: no effect on overall cognition or executive function; GRADE certainty moderate for memory, low for attention and processing speed. EFSA 2024: cause-and-effect not established for any cognitive domain; a working-memory effect only at 20 g/day for 5–7 days, not at 2.2–14 g/day or 5 g/day for 6 weeks after a 5-day loading phase. Text only: the card is always shown and no rule or dose changed |
| `supplement-collagen` | Collagen peptides | Hydrolyzed collagen peptides; may improve skin hydration and elasticity | Skin hydration/elasticity meta-analysis (Batool 2026) |
| `supplement-omega3` | Omega-3 | EPA/DHA, up to 1 g/day combined | CV benefits (Bernasconi 2021). The cognitive benefit of B vitamins may depend on good omega-3 status: in one trial, VITACOG, B vitamins slowed brain atrophy only with good omega-3 status, which was measured, not randomised (Jernerén 2015, Oulhaj 2016). The Dutch FACIT trial found the reverse: 800 mcg/day folic acid improved global cognition and processing speed only with lower omega-3 (van Soest 2021; 791 adults aged 50–70 with raised homocysteine; post hoc). WHO 2026 guideline recommends against omega-3, B, E and multivitamin-mineral supplements to reduce the risk of cognitive decline and dementia without a diagnosed deficiency (strong recommendation, moderate certainty; stated reason: 'unexpected harmful effects that outweigh any potential benefits'); it validated its 2019 advice without reassessing supplements, did not consider the omega-3 analyses of VITACOG or FACIT, and does not address omega-3 for heart health. That everyone may reasonably consider up to 1 g/day is Dr Stanfield's judgement, not a trial finding: CV benefit may rise with dose, but so may atrial fibrillation risk: AF HR 1.49 in trials testing >1 g/day vs 1.12 at ≤1 g/day (Gencer 2021). The card asks people with AF or on a blood thinner to check with their doctor first. Text only: the card is always shown and no dose is recorded or checked |
| `supplement-sleep` | Sleep support | Low-dose melatonin; glycine; magnesium glycinate. Timing (3 to 4 hours before the person wants to fall asleep) appears in roadmap_text only; the card carries no timing | Melatonin may reduce sleep onset latency (Low 2020); a longer gap between dose and bedtime predicted faster sleep onset, and the authors suggest about 3 hours (Cruz-Sanabria 2024; pooled trials of other doses and forms, not 0.8 mg sustained-release) |

---

## 10. Progressive Disclosure

Source: `mappings.ts` -> `computeFormStage(inputs, saved)`

New users see fields revealed in 3 stages. Returning users with a saved weight or any saved blood test skip to stage 3. The widget shows this stage, and the storefront chatbot embed stays muted below stage 3; both call the same function, the embed on the widget's saved copy (US-15 AC10).

`saved` is the newest saved row per metric. Its values fill the longitudinal fields the form leaves empty (`mergeLongitudinalInputs`), so a value typed in the form wins over the saved one.

A value opens a stage only when it is plausible: inside its SI validation range in `UNIT_DEFS` (height 50–250 cm, weight 20–300 kg). A half-typed "1" of "180" does not open stage 2.

| Stage | Gate Condition | Fields Visible | Attention Glow |
|-------|---------------|----------------|----------------|
| 1 | Always | Units, Sex, Height | Sex |
| 2 | `sex` set AND a plausible `heightCm` | Weight, Waist, BP, Birth Month/Year | Weight |
| 3 | a plausible `weightKg`, typed or saved; OR any saved blood test (`BLOOD_TEST_METRICS`) | Blood Tests, Medications, Screening, Bone Density, Supplements | None (Email for guests) |

Logic checks from stage 3 down (short-circuit), so returning users skip to full form. The blood-test rule lets a lab import with no weight open the whole form.

### Field Categories

**PREFILL_FIELDS** (auto-saved with debounce): `heightCm`, `sex`, `birthYear`, `birthMonth`. `unitSystem` is also auto-saved but not in the array.

**LONGITUDINAL_FIELDS** (immutable time-series, "Save New Values" button): `weightKg`, `waistCm`, `hba1c`, `creatinine`, `psa`, `apoB`, `ldlC`, `totalCholesterol`, `hdlC`, `triglycerides`, `systolicBp`, `diastolicBp`, `lpa`.

---

## 11. Reminder System

Source: `reminders.ts`

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

Same eligibility criteria as the suggestion algorithm (section 8). Checks both initial screening overdue and post-follow-up overdue. Only triggers for screenings the user has started (not `'not_yet_started'`).

### Preference Filtering

`filterByPreferences()` removes reminders for categories the user has opted out of. Global opt-out via `profiles.reminders_global_optout`.

---

## 12. Validation Ranges

Source: `units.ts` (UNIT_DEFS) + `validation.ts`

| Metric | SI Min | SI Max | Conv Min | Conv Max |
|--------|--------|--------|----------|----------|
| height | 50 cm | 250 cm | 20 in | 98 in |
| weight | 20 kg | 300 kg | 44 lbs | 661 lbs |
| waist | 40 cm | 200 cm | 16 in | 79 in |
| hba1c | 9 mmol/mol | 195 mmol/mol | 3% | 20% |
| ldl | 0 mmol/L | 12.9 mmol/L | 0 mg/dL | 500 mg/dL |
| hdl | 0 mmol/L | 5.2 mmol/L | 0 mg/dL | 200 mg/dL |
| total_cholesterol | 0 mmol/L | 15 mmol/L | 0 mg/dL | 580 mg/dL |
| triglycerides | 0 mmol/L | 22.6 mmol/L | 0 mg/dL | 2000 mg/dL |
| apob | 0 g/L | 3 g/L | 0 mg/dL | 300 mg/dL |
| creatinine | 10 umol/L | 2650 umol/L | 0.1 mg/dL | 30 mg/dL |
| systolic_bp | 60 mmHg | 250 mmHg | 60 mmHg | 250 mmHg |
| diastolic_bp | 40 mmHg | 150 mmHg | 40 mmHg | 150 mmHg |
| psa | 0 ng/mL | 10,000 ng/mL | 0 ng/mL | 10,000 ng/mL |
| lpa | 0 nmol/L | 750 nmol/L | 0 mg/dL | 300 mg/dL (= 750 / 2.5; EAS pairs 300 mg/dL with 750 nmol/L) |

### Profile Validation

- `sex`: 1 (male) or 2 (female)
- `birthYear`: 1900 to current year
- `birthMonth`: 1-12
- `unitSystem`: 1 (SI) or 2 (conventional)
- `height`: 50-250 cm

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

Auto-detected from browser locale. Countries using conventional: US, LR (Liberia), MM (Myanmar). Special en-US cross-check: if timezone is non-US (e.g. Pacific/Auckland), defaults to SI.
