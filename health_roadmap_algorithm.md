# Health Roadmap Algorithm

Single source of truth for all health calculations, clinical thresholds, medication cascades, screening logic, and suggestion rules. The code in `packages/health-core/src/` implements this algorithm. Clinical evidence (patient-facing reasons, guideline citations, DOI references) for each suggestion is defined in `packages/health-core/src/evidence.ts` and attached automatically by `generateSuggestions()`. The user-facing `roadmap_text.html` must stay consistent with this document and `evidence.ts`.

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
9. [Skin Health & Supplements](#9-skin-health--supplements)
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
| lpa | nmol/L | mg/L | / 0.24 (nmol/L ≈ 2.4 × mg/dL = 0.24 × mg/L; approximate, see Lp(a) below) |

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
| lpa | 0 | 0 |

### Lab catalogue conversions

Source: `packages/health-core/src/lab-catalog.ts` (`LAB_CONVERSIONS`, `canonicalLabValue`). Since US-21 phase 3, a lab test the catalogue knows is **stored** in its canonical SI unit, not in the unit the lab printed. A writer sends the number and the unit as printed; the record converts it once, on the write, and converts `referenceLow`/`referenceHigh` by the same factor.

Factor = the number a reported value is multiplied by to reach the canonical unit. Spellings are matched lower case, after `normalizeLabUnit` folds report and LLM spelling (`umol/L` → `µmol/L`, `mcg` → `µg`, `uL` → `µL`, `x 10e9/L` → `×10⁹/L`, `1.73m2` → `1.73m²`, `gm/dL` → `g/dL`, `Units/L` → `U/L`, `10^3/cmm` → `×10³/µL`). A factor of 1 is a different notation for the same scale, not a conversion.

A spelling this table does not carry for that test is **refused** — never rescaled by guess. The refusal names the canonical unit and every spelling the test accepts, and the website counts it as `lab_unit_refused`. Three things follow from that:

- **Prolactin in ng/mL is refused on purpose.** The mIU/L factor is assay-dependent (about 21.2 for the WHO 3rd IS), so converting would invent precision the report does not have.
- **A test the catalogue does not know is stored exactly as reported**, with its printed unit. There is no SI definition to convert it to, and refusing it would throw the value away.
- **Rows written before phase 3 are corrected at load**, not edited: `migrate.ts` appends a converted row with the id `<id>#si` and `correctsId` set, and flips the printed row to `entered-in-error`. Same id on every device, so cross-device copies merge into one row. A legacy `gm/dL` row (haemoglobin, albumin, total protein, globulin, MCHC) now converts at ×10 on load through the same path.

| key | canonical | reported spelling | × factor | note |
|-----|-----------|-------------------|----------|------|
| `sodium` | mmol/L | meq/l | 1 | mEq/L and mmol/L are the same number for a singly charged ion |
| `potassium` | mmol/L | meq/l | 1 | mEq/L and mmol/L are the same number for a singly charged ion |
| `chloride` | mmol/L | meq/l | 1 | mEq/L and mmol/L are the same number for a singly charged ion |
| `bicarbonate` | mmol/L | meq/l | 1 | mEq/L and mmol/L are the same number for a singly charged ion |
| `urea` | mmol/L | mg/dl (printed name: bun / blood urea nitrogen / urea nitrogen) | 0.357 | urea nitrogen, the molecule’s 2 N, 28.014 g/mol. mg/dL reaches this slot ONLY under a nitrogen name: under the bare name "urea" it is ambiguous (US nitrogen vs the whole molecule), so it is refused |
| `urate` | mmol/L | mg/dl | 0.05948 | urate 168.11 g/mol |
| `urate` | mmol/L | µmol/l | 0.001 | a micromole is a thousandth of a millimole (UK labs print µmol/L) |
| `urine_acr` | mg/mmol | mg/g | 0.113 | creatinine 113.12 g/mol, so 1 g ≡ 8.840 mmol |
| `egfr` | mL/min/1.73m² | ml/min/1.73 m² | 1 | spacing only |
| `egfr` | mL/min/1.73m² | ml/min/1.73 | 1 | the body-surface area left unwritten (LabCorp) |
| `alt` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `ast` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `ggt` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `alp` | U/L | iu/l | 1 | an international unit of enzyme activity IS a unit |
| `bilirubin_total` | µmol/L | mg/dl | 17.1 | bilirubin 584.66 g/mol |
| `albumin` | g/L | g/dl | 10 | a decilitre is a tenth of a litre |
| `total_protein` | g/L | g/dl | 10 | a decilitre is a tenth of a litre |
| `globulin` | g/L | g/dl | 10 | a decilitre is a tenth of a litre |
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
| `wbc` | ×10⁹/L | ×10³/mm3 | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `wbc` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | ×10³/mm3 | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `platelets` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | ×10³/mm3 | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `neutrophils` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | ×10³/mm3 | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `lymphocytes` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | ×10³/mm3 | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `monocytes` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | ×10³/mm3 | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `eosinophils` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | ×10³/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | k/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | thou/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | thousand/µl | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | ×10³/mm3 | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `basophils` | ×10⁹/L | g/l | 1 | an analyser’s spelling of ×10⁹/L (G/L is giga-, not grams) |
| `mchc` | g/L | g/dl | 10 | a decilitre is a tenth of a litre |
| `tsh` | mIU/L | µiu/ml | 1 | µIU/mL and mIU/L are the same number |
| `tsh` | mIU/L | mu/l | 1 | mU/L is mIU/L, printed short |
| `ft4` | pmol/L | ng/dl | 12.87 | thyroxine 776.87 g/mol |
| `ft3` | pmol/L | pg/ml | 1.536 | triiodothyronine 650.97 g/mol |
| `testosterone_total` | nmol/L | ng/dl | 0.0347 | testosterone 288.42 g/mol |
| `testosterone_total` | nmol/L | ng/ml | 3.467 | testosterone 288.42 g/mol |
| `estradiol` | pmol/L | pg/ml | 3.671 | estradiol 272.38 g/mol |
| `estradiol` | pmol/L | ng/l | 3.671 | estradiol 272.38 g/mol |
| `prolactin` | mIU/L | µiu/ml | 1 | µIU/mL and mIU/L are the same number (ng/mL stays refused: assay-dependent) |
| `cortisol_am` | nmol/L | µg/dl | 27.59 | cortisol 362.46 g/mol |
| `vitamin_d` | nmol/L | ng/ml | 2.496 | 25-OH-D 400.64 g/mol |
| `vitamin_d` | nmol/L | µg/l | 2.496 | 25-OH-D 400.64 g/mol |
| `vitamin_b12` | pmol/L | pg/ml | 0.738 | cyanocobalamin 1355.4 g/mol |
| `vitamin_b12` | pmol/L | ng/l | 0.738 | cyanocobalamin 1355.4 g/mol |
| `folate` | nmol/L | ng/ml | 2.266 | folate 441.4 g/mol |
| `folate` | nmol/L | µg/l | 2.266 | folate 441.4 g/mol |
| `ferritin` | µg/L | ng/ml | 1 | ng/mL and µg/L are the same number |
| `iron` | µmol/L | µg/dl | 0.179 | iron 55.845 g/mol |
| `magnesium` | mmol/L | mg/dl | 0.4114 | magnesium 24.305 g/mol |
| `magnesium` | mmol/L | meq/l | 0.5 | Mg²⁺ carries two charges |
| `calcium_corrected` | mmol/L | mg/dl | 0.2495 | calcium 40.078 g/mol |
| `zinc` | µmol/L | µg/dl | 0.153 | zinc 65.38 g/mol |
| `crp` | mg/L | mg/dl | 10 | a decilitre is a tenth of a litre |
| `esr` | mm/hr | mm/h | 1 | spelling only |

`calcium_corrected` also answers to a plain "calcium" (an existing alias), so a plain calcium converts on the corrected-calcium factor — the same number, a different test. Known, pre-existing, not fixed here.

Three-file sync: `evidence.ts` and `roadmap_text.html` are untouched because no threshold, suggestion or user-facing sentence changes — only the unit a stored number is expressed in.

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

Mass → molar is approximate: nmol/L ≈ 2.4 × mg/dL, so 0.24 × mg/L (NZ/AU/UK labs print mg/L; US labs mg/dL). The true factor runs ~2.0–2.5 with apo(a) isoform size, which is why guidelines prefer nmol/L (Kronenberg et al., EAS consensus, Eur Heart J 2022, pairs 180 mg/dL with 430 nmol/L and 300 mg/dL with 750 nmol/L; Marcovina & Albers, J Lipid Res 2016;57:526). Corrected 2026-09-07: the code had applied 2.4 per mg/L, storing every mg/L reading 10× high.

### On-Treatment Lipid Targets

Used when medications are tracked and a lipid is at or above its target: the value should be below it, so the target itself counts as above target (Brad, 2026-09-28). Cards and the form say "the treatment target is below X". Every "<X" statement of a lipid target (these cards, the borderline cards, the Lp(a) checklist and the reference hints) prints X as the first value, at the unit's display step, that the plan grades at or above the target (`formatTargetLine`): 0.50, 1.4 and 1.6 in SI; 50, 55 and 62 in mg/dL. 54 mg/dL of LDL is 1.396 mmol/L, which the plan grades below 1.4, so the mg/dL target reads 55. The LDL and non-HDL targets are also the tiles' Optimal line and the `lipid-diet` trigger, which use the same `>=` comparison. In the read-only summaries, a value printed beside its target (the cards' "Your LDL-c is…" sentence, the form's cholesterol intro, the Lp(a) checklist, the lipid tile and the MCP `get_plan` currentValues) shows on the side of X the plan grades it (`formatGradedValue`). It rounds to the display step as everywhere else, unless that would put it on the other side of X. Then a value graded at or above the target shows X, and a value graded below it shows one more decimal place, rounded down, which is always below X. So 1.40 mmol/L of LDL, at the target, shows as 55 mg/dL, not 54; 54 mg/dL (1.3964 mmol/L), below it, shows as 1.39 mmol/L, not 1.4; a non-HDL of 1.56 shows as 1.56. A value typed in the shown unit, on the display step, shows as typed. The history matrices (blood tests and vitals) are editable, so they show plain values, rounded to the display step: the number a typed value is compared against, so re-entering the shown number writes nothing (US-03 AC3). Their colour is the plan's grade. So a value within one display step of its line, entered in the other unit, can read on the other side of the hint there: 1.40 mmol/L of LDL shows as 54 mg/dL beside "<55", coloured above optimal.

| Marker | Target | Conventional |
|--------|--------|-------------|
| ApoB | < 0.5 g/L | < 50 mg/dL |
| LDL | < 1.4 mmol/L | < 55 mg/dL |
| Non-HDL | < 1.6 mmol/L | < 62 mg/dL |

---

## 4. Suggestion Algorithm

Source: `suggestions.ts` -> `generateSuggestions()`

### Always-Show Lifestyle Suggestions

| ID | Category | What | Evidence |
|----|----------|------|----------|
| `protein-target` | nutrition | Daily protein target (CKD-adjusted if eGFR < 45) | ISSN 2017 |
| `fiber` | nutrition | 25-35g fiber daily | Reynolds 2019 |
| `exercise` | exercise | 150+ min cardio + 2-3 resistance sessions/week | Physical Activity Guidelines 2018 |
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
- Medication status (statin, ezetimibe, PCSK9i — when tracked)
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
- If the weight-medication trigger is on (section 6): weight loss + GLP-1 mention

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
| Ground flaxseed | Soluble fibre + ALA omega-3 | 5–10% (~30g/day) |
| Edamame | Soy protein replacing animal protein | 3–5% |
| Extra-virgin olive oil | Monounsaturated fat replacing butter/saturated fat | Modest direct LDL effect |

### Additional Options (no IBS/IBD)

Beans, lentils, chickpeas, and mixed vegetables — high in soluble fibre but also high-FODMAP, so not recommended for IBS/IBD patients.

### Supplement

**Psyllium husk** (7g/day): 5–10% LDL reduction. Soluble, gel-forming, minimally fermented. ACG-recommended for IBS (both IBS-C and IBS-D). Well-tolerated in IBD remission.

### Key References

- Jenkins 2011 — Portfolio Diet (JAMA): [10.1001/jama.2011.1202](https://doi.org/10.1001/jama.2011.1202)
- Sabaté 2010 — Nut consumption and lipids (Arch Intern Med): [10.1001/archinternmed.2010.79](https://doi.org/10.1001/archinternmed.2010.79)
- Wei 2009 — Psyllium and cholesterol (Eur J Clin Nutr): [10.1038/ejcn.2008.49](https://doi.org/10.1038/ejcn.2008.49)

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

## 9. Skin Health & Supplements

Source: `suggestions.ts`

### Skin Health (age >= 18)

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
| `supplement-micronutrient-base` | Micronutrient base | Methylated B-complex; vitamin D3 + K2; magnesium taurate; trace minerals (glycinate); lutein + zeaxanthin; TMG; lycopene | COSMOS trial (Baker 2023) |
| `supplement-creatine` | Creatine | Creatine monohydrate, 3–5 g/day | Strength/lean mass (Kreider 2017); cognition (Avgerinos 2018) |
| `supplement-collagen` | Collagen peptides | Hydrolyzed collagen peptides, 10–15 g/day | Skin hydration/elasticity meta-analysis (Pu 2023) |
| `supplement-omega3` | Omega-3 | EPA/DHA | CV benefits (Bernasconi 2021) + cognitive synergy with B-complex (Jernerén 2015, Oulhaj 2016) |
| `supplement-sleep` | Sleep support | Low-dose melatonin; glycine; magnesium glycinate | Melatonin (Low 2020) |

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
| psa | 0 ng/mL | 100 ng/mL | 0 ng/mL | 100 ng/mL |
| lpa | 0 nmol/L | 750 nmol/L | 0 mg/L | 3125 mg/L (= 750 / 0.24) |

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
