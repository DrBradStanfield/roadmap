# Health Roadmap Algorithm

Single source of truth for all health calculations, clinical thresholds, medication cascades, screening logic, and suggestion rules. The code in `packages/health-core/src/` implements this algorithm. The user-facing `roadmap_text.html` must stay consistent with this document.

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
| 25.0–29.9 | unknown | *(no label)* | Prompt to measure waist circumference |
| 30.0–34.9 | any | Obese (Class I) | — |
| 35.0–39.9 | any | Obese (Class II) | — |
| >= 40.0 | any | Obese (Class III) | — |

**Key principle:** BMI 25–29.9 with normal WHtR (< 0.5) and no metabolic risk factors should NOT trigger weight management suggestions.

### Waist-to-Height Ratio

`waistCm / heightCm` — rounded to 2 decimal places. Values >= 0.5 indicate increased metabolic risk. When BMI is 25–29.9 and waist data is missing, a "Measure your waist circumference" suggestion is shown.

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

`totalCholesterol - HDL` (mmol/L) — rounded to 1 decimal place.

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
| lpa | nmol/L | nmol/L | (same) |

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

### LDL Cholesterol (mmol/L)

| Level | mmol/L | mg/dL |
|-------|--------|-------|
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
| Borderline | 4.14 | 160 |
| High | 4.91 | 190 |
| Very high | 5.69 | 220 |

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

**Age-dependent target:**
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

| Level | nmol/L |
|-------|--------|
| Normal | < 75 |
| Borderline | 75–125 |
| Elevated | >= 125 |

### On-Treatment Lipid Targets

Used when medications are tracked and lipids exceed these targets.

| Marker | Target | Conventional |
|--------|--------|-------------|
| ApoB | <= 0.5 g/L | <= 50 mg/dL |
| LDL | <= 1.4 mmol/L | <= ~54 mg/dL |
| Non-HDL | <= 1.6 mmol/L | <= ~62 mg/dL |

---

## 4. Suggestion Algorithm

Source: `suggestions.ts` -> `generateSuggestions()`

### Always-Show Lifestyle Suggestions

| ID | Category | What |
|----|----------|------|
| `protein-target` | nutrition | Daily protein target (CKD-adjusted if eGFR < 45) |
| `fiber` | nutrition | 25-35g fiber daily |
| `exercise` | exercise | 150+ min cardio + 2-3 resistance sessions/week |
| `sleep` | sleep | 7-9 hours nightly |

### Conditional Lifestyle Suggestions

| ID | Condition | Priority |
|----|-----------|----------|
| `low-salt` | systolicBp > 120 (age < 65) or > 130 (age >= 65) | info |
| `high-potassium` | eGFR >= 45 (safe kidney function) | info |
| `trig-nutrition` | triglycerides >= 1.69 mmol/L | attention |
| `reduce-alcohol` | BMI >= 30, OR (BMI > 25 AND WHtR >= 0.5), OR triglycerides >= 1.69 mmol/L | attention |

### HbA1c Tiers

| ID | Condition | Priority |
|----|-----------|----------|
| `hba1c-diabetic` | >= 47.5 mmol/mol (>= 6.5%) | urgent |
| `hba1c-prediabetic` | >= 38.8 mmol/mol (>= 5.7%) | attention |
| `hba1c-normal` | < 38.8 mmol/mol | info |

### Atherogenic Lipid Hierarchy

**Only show the best available marker:** ApoB > non-HDL > LDL.

ApoB is always shown when available. LDL is only shown when both ApoB AND non-HDL are unavailable. Non-HDL is only shown when ApoB is unavailable.

Each marker has three tiers (borderline/high/very high) using the thresholds in section 3.

**Total cholesterol** is suppressed when an elevated atherogenic marker already produced an attention/urgent suggestion, or when the lipid medication cascade is active.

### Lp(a)

| ID | Condition | Priority |
|----|-----------|----------|
| `lpa-elevated` | >= 125 nmol/L | attention |
| `lpa-borderline` | 75-125 nmol/L | info |
| `lpa-normal` | < 75 nmol/L | info |

**Elevated Lp(a) checklist** (modifiable risk factors):
- Lipids (ApoB > non-HDL > LDL, on-treatment targets)
- Blood pressure (target < 120/80)
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
- If BMI >= 30, or BMI >= 25 with WHtR >= 0.5: weight loss + GLP-1 mention

---

## 5. Cholesterol Medication Cascade

Source: `suggestions.ts` (lipids section) + `types.ts` (statin helpers)

### Trigger

All three conditions must hold:
1. `medications` object is provided (user is tracking medications)
2. At least one lipid marker exceeds on-treatment targets:
   - ApoB > 0.5 g/L, OR
   - LDL > 1.4 mmol/L, OR
   - Non-HDL > 1.6 mmol/L

### Step 1: Start Statin (`med-statin`)

**Condition:** Statin is null, undefined, `'none'`, or has an invalid drug name (handles old tier-based migration data).

### Step 2: Add Ezetimibe (`med-ezetimibe`)

**Condition:** On a statin (or statin not tolerated) AND ezetimibe is `undefined`, `'no'`, or `'not_yet'`.

### Step 3: Statin Escalation (`med-statin-increase` or `med-statin-switch`)

**Condition:** Ezetimibe handled (yes or not tolerated) AND statin tolerated AND escalation gate `statinEscalation` is `undefined` or `'not_yet'`.

- `canIncreaseDose(drug, dose)`: Higher dose available for current statin
- `shouldSuggestSwitch(drug, dose)`: On max dose of current statin, potency > 0, potency < 63%
- `isOnMaxPotency(drug, dose)`: Potency >= 63% (rosuvastatin 40mg)

### Step 4: PCSK9 Inhibitor (`med-pcsk9i`)

**Condition:** Statin escalation not tolerated, or already at max potency, or no escalation possible. AND pcsk9i is `undefined`, `'no'`, or `'not_yet'`.

### Statin Potency Table (BPAC 2021)

| Drug | Dose -> % LDL Reduction |
|------|------------------------|
| rosuvastatin | 5mg: 40%, 10mg: 47%, 20mg: 55%, 40mg: 63% |
| atorvastatin | 10mg: 30%, 20mg: 40%, 40mg: 47%, 80mg: 55% |
| simvastatin | 10mg: 30%, 20mg: 35%, 40mg: 40% |
| pravastatin | 20mg: 30%, 40mg: 40% |
| pitavastatin | 1mg: 30%, 2mg: 35%, 4mg: 40% |

**Max potency:** 63% (rosuvastatin 40mg).

---

## 6. Weight & Diabetes Medication Cascade

Source: `suggestions.ts` (weight section) + `types.ts` (GLP-1 helpers)

### Trigger

All conditions:
1. `medications` object is provided
2. BMI classified as elevated (`bmiCategory` is Overweight or Obese — **not** Normal after WHtR reclassification)
3. BMI > 28 (unconditional) OR at least one secondary criterion:
   - HbA1c >= 38.8 mmol/mol (prediabetic)
   - Triglycerides >= 1.69 mmol/L
   - Systolic BP >= 130 mmHg
   - Waist-to-height >= 0.5

**Note:** BMI 25-29.9 with healthy waist-to-height ratio (< 0.5) is reclassified as Normal by `getBMICategory()` and does NOT trigger the cascade.

### Step 1: Start GLP-1 (`weight-med-glp1`)

**Condition:** GLP-1 is null, undefined, or drug is `'none'`.

### Step 2: GLP-1 Escalation (`weight-med-glp1-increase` or `weight-med-glp1-switch`)

**Condition:** On a GLP-1 (or on 'other') AND escalation gate `glp1Escalation` is `undefined` or `'not_yet'`.

- `canIncreaseGlp1Dose(drug, dose)`: Higher dose available for current drug
- `shouldSuggestGlp1Switch(drug, dose)`: On `'other'`, OR on max dose of non-tirzepatide GLP-1
- `isOnMaxGlp1Potency(drug, dose)`: tirzepatide at max dose (15mg)

### Step 3: SGLT2i (`weight-med-sglt2i`)

**Condition:** GLP-1 escalation handled or not possible AND sglt2i is null, undefined, or drug is `'none'`.

### Step 4: Metformin (`weight-med-metformin`)

**Condition:** SGLT2i handled (on one or not tolerated) AND metformin is `undefined` or `'none'`.

### Standalone GLP-1 Suggestion (`weight-glp1`)

When the cascade is NOT active (medications not provided or conditions not met) AND BMI is classified as elevated:
- BMI > 28: Always suggest
- BMI 25-28: Suggest if waist-to-height >= 0.5 OR triglycerides >= 1.69 mmol/L (do NOT assume risk when waist data missing)

Same WHtR reclassification applies: BMI 25-29.9 with healthy WHtR (< 0.5) = Normal → no standalone GLP-1 suggestion.

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

| ID | Title | Link |
|----|-------|------|
| `supplement-microvitamin` | MicroVitamin+ | drstanfield.com |
| `supplement-omega3` | Omega-3 | Amazon |
| `supplement-sleep` | Sleep by Dr Brad | drstanfield.com |

---

## 10. Progressive Disclosure

Source: `mappings.ts` -> `computeFormStage()`

New users see fields revealed in 4 stages. Returning users with data skip to stage 4.

| Stage | Gate Condition | Fields Visible | Attention Glow |
|-------|---------------|----------------|----------------|
| 1 | Always | Units, Sex, Height | Sex |
| 2 | `sex !== undefined AND heightCm !== undefined` | Birth Month, Birth Year | Birth Month |
| 3 | `birthMonth !== undefined AND birthYear !== undefined AND birthYear >= 1900` | Weight, Waist | Weight |
| 4 | `weightKg !== undefined` | BP, Blood Tests, Medications, Screening | None |

Logic checks from stage 4 down (short-circuit), so returning users skip to full form.

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
| lpa | 0 nmol/L | 750 nmol/L | 0 nmol/L | 750 nmol/L |

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
