# Medications & Supplements Tracking

## Problem

1. **Blind spot when medications are working.** If a user takes a statin and their LDL-c is now normal, the medication cascade never triggers. The tool doesn't know they're on a statin, can't credit good adherence, and can't contextualize their lab trends.

2. **Cascade trigger gaps.** Beyond the "meds are working" case, Lp(a) elevation can trigger a statin suggestion even when LDL-c is fine. But the statin cascade only fires on elevated lipid markers — so the user sees "consider a statin" without ever being asked if they're already on one.

3. **No medication history.** The `medications` table is mutable (UPSERT). Only current state is stored. There's no way to see when a medication was started, stopped, or dose-changed — which makes lab trend charts much less useful.

4. **No supplement tracking.** Users take supplements that may affect their health metrics (e.g., vitamin D, omega-3, magnesium). There's no way to record these or correlate them with lab changes.

## Goals

- Fix the cascade trigger logic so medication questions appear whenever the suggestion engine recommends a medication (not just when raw values are elevated)
- Track medication changes over time with FHIR-compliant history
- Show medication/supplement change markers on health history charts
- Add a supplements section for logged-in users
- Keep the tool focused — medication sections gated by relevant blood test entry, not shown prematurely

## Non-Goals

- Medication reminders or adherence tracking (separate feature)
- Drug interaction checking
- Supplement dosing recommendations
- Replacing the existing cascade flow

---

## Design

### 1. Fix Cascade Triggers (Guests + Logged-In)

**Current behavior:** The cholesterol medication cascade shows only when `lipidMarker?.elevated === true`. The weight/diabetes cascade shows only when BMI thresholds are met.

**New behavior:** Show the medication cascade when EITHER:
- (a) The raw values trigger it (existing logic), OR
- (b) The suggestion engine generates a medication-related suggestion (e.g., `statin-start`, `statin-increase`, `ezetimibe-add`, `glp1-start`, etc.)

This creates a feedback loop: suggestions drive cascade visibility, and cascade responses refine suggestions. Handles the Lp(a) case naturally — if Lp(a) suggests "consider a statin," the statin question appears.

**Impact:** Both guests and logged-in users benefit. No new UI — just smarter trigger logic.

### 1b. Always-Visible Medication Sections (Guests + Logged-In)

The cascade fix (1a) handles the case where suggestions exist but the cascade didn't trigger. But there's a remaining gap: **what if all values are fine and no suggestions fire, but the user is on medications?** (e.g., well-controlled on statin + ezetimibe, no Lp(a) tested)

**Solution:** For all users (guests and logged-in), show optional medication sections below the relevant blood test sections once the user has entered the minimum blood tests for that category — even when the cascade isn't triggered.

**Visibility gate** (not auth-based, blood-test-based):
- **Cholesterol medications:** Shown once the user has entered at least one lipid marker (ApoB, LDL-c, total cholesterol, or HDL)
- **Weight & diabetes medications:** Shown once the user has entered at least one of: HbA1c, weight (with height for BMI), or triglycerides

**Cholesterol Medications** (below cholesterol blood tests):
- **Statin:** Drug + dose dropdown (same UX as cascade)
- **Ezetimibe:** Yes/No toggle (always 10mg)
- **Bempedoic acid:** Dropdown — Nexletol 180mg / Nexlizet (combo with ezetimibe) / None / Not tolerated *(new medication key)*
- **PCSK9i:** Drug dropdown (evolocumab 140mg / alirocumab 75mg or 150mg / none / not tolerated)

**Weight & Diabetes Medications** (below relevant blood tests):
- **GLP-1:** Drug + dose dropdown (same UX as cascade)
- **SGLT2i:** Drug + dose dropdown (same UX as cascade)
- **Metformin:** Formulation + dose dropdown (same UX as cascade)

**Interaction with cascade:**
- When the cascade IS triggered (by values or suggestions), it replaces this section with the full progressive cascade flow
- When the cascade is NOT triggered, this simpler flat layout appears instead
- Both write to the same `medications` table — identical data model
- Guest medication data cached to localStorage; syncs to cloud on login

**New medication key — `bempedoic_acid`:**

| medication_key | drug_name | dose_value | dose_unit | Notes |
|---------------|-----------|------------|-----------|-------|
| bempedoic_acid | bempedoic_acid | 180 | mg | Nexletol |
| bempedoic_acid | bempedoic_acid_ezetimibe | 180 | mg | Nexlizet (combo pill) |
| bempedoic_acid | none | NULL | NULL | Not taking |
| bempedoic_acid | not_tolerated | NULL | NULL | Tried but can't tolerate |

Requires: DB migration (`ALTER TABLE medications` to add to CHECK constraint), new validation key, cascade integration, suggestion logic.

### 2. Medication History (FHIR MedicationStatement)

**Current `medications` table stays unchanged** — it's the "current state" view that the cascade depends on (UNIQUE per user_id + medication_key).

**New `medication_history` table** — immutable, append-only log of every medication change:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | FK to profiles |
| medication_key | TEXT | Same keys as medications table |
| drug_name | TEXT | Drug name at time of change |
| dose_value | NUMERIC | Dose at time of change |
| dose_unit | TEXT | Unit at time of change |
| status | TEXT | FHIR status: active, stopped, intended, not-taken, on-hold |
| effective_start | TIMESTAMPTZ | When this state began (user-provided or defaulted to now) |
| effective_end | TIMESTAMPTZ | When this state ended (NULL = current) |
| change_type | TEXT | 'started', 'stopped', 'dose_changed', 'switched', 'initial' |
| source | TEXT | 'manual', 'cascade', 'import' |
| created_at | TIMESTAMPTZ | Record creation time |

**FHIR mapping:**
- Each row = one `MedicationStatement` resource
- `effectivePeriod.start` = `effective_start`
- `effectivePeriod.end` = `effective_end`
- `status` uses FHIR ValueSet (active, completed, stopped, etc.)
- `medicationCodeableConcept` derivable from drug_name
- Compatible with Apple Health's medication tracking model

**Write flow:**
1. User changes a medication via cascade or panel
2. Current `medications` row is UPSERTed (existing behavior)
3. If the previous state differs from the new state:
   - Close the previous history row (set `effective_end = now`)
   - Insert new history row (set `effective_start = now`, `effective_end = NULL`)
4. On first save for a medication, create an 'initial' record

**Migration from existing data:**
- For users with existing medications, backfill `medication_history` with one 'initial' record per medication using `medications.created_at` as `effective_start`.

### 3. Supplement Tracking (Logged-In Only)

**New section** at the bottom of the left-hand input panel, visible only for logged-in users at form stage 4.

**Hybrid UI:** 4 featured supplements as quick-add chips (MicroVitamin, MicroVitamin+, Sleep, Omega-3), plus a searchable "Add other" dropdown with a curated list and free-text entry. See Decisions section for full list.

**Storage:** New `supplements` table (same pattern as medications):

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | FK to profiles |
| supplement_key | TEXT | e.g., 'omega3', 'vitamin_d', 'magnesium', 'custom_...' |
| supplement_name | TEXT | Display name (especially for custom entries) |
| dose_value | NUMERIC | Dose amount |
| dose_unit | TEXT | mg, mcg, IU, etc. |
| status | TEXT | active, stopped |
| started_at | TIMESTAMPTZ | When started |
| updated_at | TIMESTAMPTZ | Last modified |
| created_at | TIMESTAMPTZ | Record creation |
| UNIQUE(user_id, supplement_key) | | One entry per supplement per user |

**New `supplement_history` table** — same immutable, append-only pattern as `medication_history`:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | FK to profiles |
| supplement_key | TEXT | Same keys as supplements table |
| supplement_name | TEXT | Display name (especially for custom entries) |
| dose_value | NUMERIC | Dose at time of change |
| dose_unit | TEXT | mg, mcg, IU, etc. |
| status | TEXT | active, stopped |
| effective_start | TIMESTAMPTZ | When this state began |
| effective_end | TIMESTAMPTZ | When this state ended (NULL = current) |
| change_type | TEXT | 'started', 'stopped', 'dose_changed' |
| source | TEXT | 'manual' |
| created_at | TIMESTAMPTZ | Record creation time |

**Write flow** mirrors medications: UPSERT `supplements` row → diff against previous state → close old history record → insert new history record. Chart annotations pull from this table.

**UI approach:**
- Section header: "Supplements"
- Multi-select dropdown or searchable list to add supplements
- Each active supplement shows: name, dose, unit, date started
- "Add supplement" button to add from curated list or enter custom
- Simple, compact layout — this isn't the focus of the tool

### 4. Chart Annotations

**On HistoryPanel charts**, overlay vertical markers for medication and supplement changes.

**Visual design:**
- Vertical dashed line at the date of change
- Small label above/below the line: "Started atorvastatin 10mg" or "Stopped vitamin D"
- Color-coded: medications in one color, supplements in another (visually distinct from chart lines)
- Clickable to show full details in a tooltip

**Which charts get which markers:**
- Statin/ezetimibe/bempedoic acid/PCSK9i changes → LDL-c, ApoB, total cholesterol charts
- GLP-1/SGLT2i/metformin changes → HbA1c, weight, triglycerides charts
- Supplements → relevant metric charts (e.g., vitamin D supplement → vitamin D lab values if tracked)
- A "show all medication changes" toggle if too cluttered

**Implementation:** Chart.js `chartjs-plugin-annotation` — supports vertical line annotations natively. Already compatible with our Chart.js 4.x setup.

**Data source:** Query `medication_history` and `supplement_history` for the same date range as the chart data. Merge into annotation config.

---

## User Flows

### Flow 1: Logged-in user with controlled LDL (your case)

1. User enters blood test values — LDL-c is 1.8 mmol/L (normal, on treatment)
2. Lp(a) is elevated → suggestion engine says "consider statin if not already taking"
3. **New:** Cascade triggers because suggestion mentions statin
4. User selects "atorvastatin 10mg" — tool records it, closes the suggestion
5. History chart for LDL-c shows a vertical marker: "Started atorvastatin 10mg" at the recorded start date
6. Next visit, LDL-c values show a clear downtrend after the statin marker

### Flow 2: User with all values normal, on medications (guest or logged-in)

1. User enters blood test values — LDL-c is normal (well-controlled on treatment)
2. No cascade triggers, no medication suggestions
3. **New:** "Cholesterol Medications" section appears below blood tests (because a lipid marker was entered)
4. User selects atorvastatin 20mg, toggles ezetimibe to Yes
5. Date picker defaults to today — user backdates statin to March 2024
6. Medications recorded; chart annotations show start dates on LDL-c chart
7. Next blood test entry shows the medication context alongside lab trends

### Flow 3: Guest user with high Lp(a)

1. Guest enters Lp(a) value — elevated
2. Suggestion: "Consider discussing statin therapy with your doctor"
3. **New:** Statin cascade appears (triggered by suggestion, not lipid elevation)
4. Guest can indicate they're already on a statin — suggestion updates accordingly
5. Data cached to localStorage; syncs to cloud if they sign up

### Flow 4: Logged-in user tracking supplements

1. User scrolls to bottom of input panel → sees "Supplements" section
2. Clicks "Add supplement" → selects "Omega-3 (EPA/DHA)" from dropdown
3. Enters dose: 2000mg, started: January 2026
4. Supplement appears in their list with an edit/remove option
5. On history charts for triglycerides, a marker shows "Started Omega-3 2000mg"

### Flow 5: Medication dose change

1. User is on atorvastatin 10mg, changes to 20mg in the cascade
2. System closes the history record for "atorvastatin 10mg"
3. Opens new record for "atorvastatin 20mg" with today's date
4. Chart shows two markers: original start, and dose increase date

---

## Decisions

### Date Entry for Medications/Supplements
Date picker that defaults to today's date. Users can backdate if they want (e.g., "I started atorvastatin 6 months ago"). Month/year granularity is sufficient — we already have a `DatePicker` component for this.

### Chart Annotation Density
- Show medication change markers on relevant charts by default
- If >3 markers would appear on a single chart, use smart filtering: only show markers for medications relevant to that specific metric (e.g., statins on LDL chart, GLP-1 on HbA1c chart)
- Provide a "Show all medication changes" toggle for users who want the full picture
- Supplement markers hidden by default, toggleable

### Supplement UI: Hybrid Approach
- **Quick-add row:** Show 4 featured supplements as chips/buttons: MicroVitamin, MicroVitamin+, Sleep, Omega-3
- **Add other:** Searchable dropdown for the full curated list + custom free-text entry
- When a supplement is added, show: name, dose field, unit dropdown, date started (date picker defaulting to today)
- Active supplements listed compactly with edit/remove options

### Supplement List (Curated)

**Featured (quick-add chips):**
- MicroVitamin
- MicroVitamin+
- Sleep
- Omega-3 (EPA/DHA)

**Full list (in 'Add other' dropdown):**

| Category | Supplements |
|----------|------------|
| Cardiovascular | CoQ10, Plant sterols, Red yeast rice, Berberine, Niacin, Citrus bergamot |
| Metabolic | Vitamin D, Magnesium, Chromium, Alpha-lipoic acid |
| Bone Health | Calcium, Vitamin K2 |
| General | Multivitamin, Iron, Zinc, B-complex, Probiotics, Creatine, Collagen |
| Other | Free-text entry |

---

## Future Considerations (Out of Scope for v1)

1. **Supplement-suggestion integration:** Should supplements eventually influence suggestions? (e.g., "You're taking omega-3 — your triglycerides may improve. Recheck in 3 months.")

2. **Data export / FHIR API:** Medication and supplement history should be included in a future FHIR data export endpoint.

3. **Supplement evidence ratings:** Could show evidence quality (strong/moderate/weak) next to each supplement to avoid implying equivalence with medications.
