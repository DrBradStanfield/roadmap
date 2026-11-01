# Blood tests from Apple Health: can the iPhone app import them?

Draft plan, 2026-11-02. Nothing built. Asked by Brad: "If we can auto import blood
tests from Apple, that would be a huge unlock."

## The answer

**Not in New Zealand.** Blood tests reach Apple Health as *Health Records*: FHIR files
that a hospital or clinic sends to the Health app. Apple lists that feature in three
countries only: Canada, the United Kingdom and the United States. New Zealand and
Australia are not on the list. So Brad, and every NZ user, would see nothing.

**Export is impossible everywhere.** Apple makes clinical records read-only. No app can
write a lab result into Health as a lab result. The one lab-like value an app can write
is blood glucose (an ordinary quantity type).

**For US, UK and Canadian users it is feasible**, with Apple's extra "Clinical Health
Records" entitlement, a second permission sheet, and parsing the FHIR JSON ourselves.
It is real work (a FHIR parser, a LOINC map, a schema addition) for a minority of
users we cannot test on Brad's own phone.

**Recommendation:** do not build it now. Build the alternative that helps every user,
NZ included: get a lab report into the app in two taps (a share-sheet extension from
the patient portal, Mail or Photos) on top of the lab-PDF import we already have. Keep
Health Records as a later, US/UK/Canada-only phase once the App Store build has US
users. Details and options below.

## 1. What Apple's documentation says (verified 2026-11-02)

Apple's developer pages render in the browser, so they were read from their JSON
source (`developer.apple.com/tutorials/data/documentation/…json`). Quotes are Apple's.

**How lab results live in HealthKit.**
- Health Records are FHIR, downloaded by the system: "Users can download their FHIR
  records from supported healthcare institutions. The system then updates the records
  in the background on a regular basis."
  ([Accessing Health Records](https://developer.apple.com/documentation/healthkit/accessing-health-records))
- Each record is one `HKClinicalRecord` sample holding "a single condition, procedure,
  or result." Lab results are the `labResultRecord` type. HealthKit "splits the
  observation type into the labResultRecord and vitalSignRecord identifiers", so a
  blood test arrives as a FHIR **Observation**. (Same page.)
- The full data is raw JSON: "use the data property to access the underlying JSON". We
  parse it; HealthKit does not. The resource also exposes `identifier`, `resourceType`
  and `sourceURL` ("The full URL for the source of the FHIR resource",
  [sourceURL](https://developer.apple.com/documentation/healthkit/hkfhirresource/sourceurl)).
- **Gotcha:** the sample's dates are NOT the test date. "The startDate and endDate
  reflect the time and date when the system downloaded the FHIR data"
  ([HKClinicalRecord](https://developer.apple.com/documentation/healthkit/hkclinicalrecord)).
  The draw date must come from the FHIR JSON (`effectiveDateTime`).

**Versions.** `HKClinicalRecord` and `labResultRecord`: iOS 12 and later. `HKFHIRVersion`
(which tells DSTU2 from R4): iOS 14 and later, with `primaryDSTU2()` and `primaryR4()`
([HKFHIRVersion](https://developer.apple.com/documentation/healthkit/hkfhirversion)). Our
app's minimum is iOS 17 (`IPHONEOS_DEPLOYMENT_TARGET`), above both.

**Entitlement and strings.**
- "When you enable your app's HealthKit capabilities, you must also select the Clinical
  Health Records checkbox." (Accessing Health Records.) That checkbox adds a value to
  `com.apple.developer.healthkit.access`, the entitlement for "Health data types that
  require additional permission"
  ([entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.healthkit.access)).
  The exact value string (believed to be `health-records`) was not on the page I read: not confirmed.
- A new purpose string, `NSHealthClinicalHealthRecordsShareUsageDescription`: "This key
  is required if your app uses APIs that access the user's clinical records"
  ([key](https://developer.apple.com/documentation/bundleresources/information-property-list/nshealthclinicalhealthrecordsshareusagedescription)).

**Read-only.** "Clinical records are read-only, so you can't request authorization to
share clinical record types. You can't create or save new HKClinicalRecord objects."
(Accessing Health Records; repeated on
[HKClinicalTypeIdentifier](https://developer.apple.com/documentation/healthkit/hkclinicaltypeidentifier).)

**Permission flow.**
- The app asks per record type ("request permission to read each record type").
- Clinical types can be asked in the same call as our current types, but "HealthKit
  presents the clinical record types in a separate permission sheet".
- The person also chooses, for new records, "whether the app automatically receives the
  data or needs to ask for permission first"
  ([sample data](https://developer.apple.com/documentation/healthkit/accessing-sample-data-in-the-simulator)).
  "Auto import" holds only if they pick the first.
- As with all HealthKit reads, the app cannot tell a refusal from an empty store (our
  D6 already handles this for vitals). Not restated on these pages; from our own code.

**App Review.** "Apps that read clinical record data must have a valid Privacy Policy
URL"; it appears on the permission sheet. "App Review may reject apps that don't use
clinical record data appropriately." (Accessing Health Records.) Guideline 5.1.3 then
applies as it does now (no advertising or data mining, no health data in iCloud, say
what is collected). The 5.1.3 wording here comes from a summary of the
[guidelines page](https://developer.apple.com/app-store/review/guidelines/#health-and-health-research),
not a verbatim read: check it before submission.

**Testing.** "You cannot create your own HKClinicalRecord samples." The simulator has
three sample accounts with static data (sample-data page). A real record needs a real
patient at a supported institution.

## 2. Where it works

Apple's [feature availability page](https://www.apple.com/ios/feature-availability/),
read 2026-11-02, entry "Health: Download Health Records to iPhone": **Canada, United
Kingdom, United States.** Nothing else. "Lab Results Highlights and Pinning" and "Lab
Results Educational Content" are United States only.

**New Zealand: no.** Australia: no.

Could not confirm:
- How many providers take part in the UK and Canada, or how many US patients have
  connected one. Apple's institution list (institutions.healthrecords.apple.com) is a
  script-driven page I could not read. I don't know what share of our US users would
  have records.
- The exact connect steps (Health app, then a provider search and the patient-portal
  sign-in). Apple's support guide only showed its table of contents.
- An Apple Community post says NZ's Health app offers "clinical documents" (CDA files)
  instead of Health Records. A forum post, not Apple: unconfirmed.
- Health NZ's national Shared Digital Health Record: a search result says first data at
  the end of 2026 and primary-care data from mid-2027
  ([Health NZ, July 2026](https://www.healthnz.govt.nz/news-and-updates/shared-digital-health-record-update-july-2026)).
  I could not read the page itself, and nothing says it will feed Apple Health or a
  third-party app.

## 3. Lab values as ordinary, writable HealthKit types

Apple's [quantity type list](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier)
(read 2026-11-02) has **blood glucose** and **blood alcohol content**. No HbA1c, no
lipids, no creatinine, no PSA, no ferritin. Everything else in our catalogue exists in
Health only as a read-only clinical record.

- Blood glucose is readable and writable. D6 deliberately skips it today: it is a
  catalogue lab value and lab rows have no `externalId` to dedup on.
- Apps **can write CDA documents** (`HKCDADocumentSample`, iOS 10, "Save the sample to
  the HealthKit store",
  [init](https://developer.apple.com/documentation/healthkit/hkcdadocumentsample/init(data:start:end:metadata:))).
  A CDA is an XML clinical document, shown in Health as a document, not as lab values
  Health can chart. So "export" could at best mean a document; I don't know how the
  Health app presents one. Low value; not recommended.
- No third-party route writes a lab result Health treats as a lab result.

## 4. What arrives: FHIR Observation, LOINC, units

- **Versions:** DSTU2 and R4 (`HKFHIRVersion`). An older connection may still send DSTU2.
  Decode by version, fixtures for both, refuse others visibly.
- **What a US lab Observation carries.** The US Core lab profile
  ([US Core 6.1](https://hl7.org/fhir/us/core/STU6.1/StructureDefinition-us-core-observation-lab.html))
  requires "a laboratory LOINC code, if available", a numeric result with "a standard
  UCUM unit", and a day-precise date. The code binding is "extensible": a provider may
  send only a local code when no LOINC fits, or both.
- **Reliability.** The constraint reads "SHALL use UCUM" only when a unit system is
  present; a provider may send a bare unit string. So:
  - Expect LOINC on most US results; expect some with only a local code and display text.
  - Expect several LOINC codes for one test (LDL calculated vs direct; HbA1c % vs mmol/mol;
    creatinine by mass vs by moles). The map is many-to-one.
  - Expect UCUM spellings our catalogue does not hold (`10*9/L`, `10*3/uL`, `mg/dL`,
    `umol/L`). They need aliases, never guesses.
  - UK and Canadian feeds: profiles not checked. Unknown.
  - Results can be `preliminary`, `final`, `amended`, `corrected`, `cancelled` or
    `entered-in-error`. Only some should land (below).
- Not verified: whether `labResultRecord` ever holds a DiagnosticReport rather than an
  Observation. `resourceType` tells; anything not an Observation is skipped and counted.

## 5. Options

| | What | Who it helps | Cost | Risk |
|---|---|---|---|---|
| **A** | Do nothing more | | none | none |
| **B** | Health Records import (read only), US/UK/Canada | US/UK/CA users with a connected provider | large: FHIR parser, LOINC map, schema addition, entitlement, second sheet | App Review on a new entitlement; LOINC/unit mistakes are clinical errors; we cannot see a real record |
| **C** | Lab report to the app in two taps: a share-sheet extension, so "Share › Health Roadmap" from a portal app, Mail, Files or Photos runs today's lab-PDF import | everyone, NZ included | small to medium: the app has neither a share extension nor document types today. Cheapest: declare PDF and image document types so the share sheet offers "Open in Health Roadmap"; fuller: a share extension | low; the same US-52 import as today |
| **D** | Blood glucose both ways with Apple Health | people with meters or CGMs | small once lab rows have an `externalId` (B's step 1) | CGMs write many readings a day; we keep one per day |
| **E** | Write a CDA document to Health | almost no one | medium | odd UX; not lab values |

**Recommended: C now. B later, only for US/UK/Canada, when the App Store build has US
users asking for it. D rides on B's first step.** A share extension fixes the NZ problem
Brad has (results arrive as a portal page or PDF), and the import it triggers already
exists. B is worth it only if enough US users have Health Records, which we cannot
measure until the app is in the US store.

Trade-off stated: B is the only true "auto" import, and the US is the market for Brad's
products (US-61). If Brad wants B for the US anyway, the plan below is how.

## 6. If B is built: the design

### Reading (iOS)
- Ask for `labResultRecord` in onboarding's one Apple Health request (Brad 2026-10-26,
  "just do it in one step"), only on iOS where the storefront is US, GB or CA (D14's
  storefront rule). Elsewhere the sheet would offer nothing and confuse.
  Health shows it as a separate sheet anyway.
- `HealthKitClient` stays the only file touching HealthKit: an anchored query on
  `labResultRecord`, observer plus background delivery as for vitals (whether background
  delivery fires for clinical types is not confirmed; test on the simulator).
- Swift passes each record's raw `fhirResource.data`, its FHIR version, `identifier`
  and `sourceURL` to the engine. Swift parses nothing (D2: one engine).

### Parsing and mapping (health-core)
- New `fhir-lab-import.ts`: parse the JSON once with Zod where it enters (CLAUDE.md
  security rule; a provider's JSON is external text). Keep `code.coding[]`,
  `code.text`, `valueQuantity` (value, unit, code, system), `effectiveDateTime`,
  `status`, `referenceRange[0].low/high`. Anything else is dropped.
- **LOINC map:** a `loinc: string[]` field on each `LAB_CATALOG` entry and on the core
  lab metrics in `mappings.ts`. Many codes per entry. A starting list, from memory and
  unverified, for Brad to check against loinc.org: HbA1c 4548-4 (%), 59261-8 (mmol/mol);
  LDL 13457-7 (calculated), 18262-6 (direct); total cholesterol 2093-3; HDL 2085-9;
  triglycerides 2571-8; ApoB 1884-6; creatinine 2160-0 (mass), 14682-9 (moles); PSA
  2857-1; Lp(a) 10835-7 (mass), 43583-4 (moles); glucose 2345-7; ferritin 2276-4; TSH 3016-3.
  This map is clinical-adjacent: Brad approves it, adversary plus Codex review it.
- **No LOINC match:** do not fall back to `code.text` through the PDF aliases on the
  first build. A name match is how the PDF import works, but a feed that sends a local
  code is the feed most likely to name a test oddly. Count it, show it as "not read".
  (Brad's question 4.)
- **Units:** reuse `toStoredLab` and the catalogue's unit aliases, the PDF path, so a
  value converts or is refused the same way however it came in. Add UCUM spellings as
  aliases (`10*9/L` = ×10⁹/L, `umol/L` = µmol/L). HbA1c % goes through the existing NGSP
  to IFCC conversion in `units.ts`. An unknown unit is refused and shown, never guessed
  (US-21 AC15's rule).
- **Status:** `final`, `amended`, `corrected` land. `preliminary`, `registered`,
  `cancelled`, `unknown` do not. `entered-in-error` from the provider: Brad's question 3.

### Rows, dedup and the FHIR invariants
- **The day:** `recordedAt` is the Observation's `effectiveDateTime` with its offset, as
  D6 does for vitals. Never the HealthKit sample date (the download date). An
  Observation with no effective date is skipped and counted.
- **Source:** a new `MeasurementSource`, `health_records`, separate from `apple_health`
  (a scale or a cuff). Provenance matters clinically: a lab result from a hospital is
  not a device reading. The institution's name is not stored (no field; question 5).
- **Stable key:** `sourceURL` (or `resourceType/id` when absent) is the record's own id.
  Core lab metrics (HbA1c, LDL, ApoB…) are `FileMeasurement` rows, which already have
  `externalId`. Catalogue lab values are `FileLabValue` rows, which do **not**.
  - **B1 (recommended):** add an optional `externalId` to `FileLabValue`. A schema
    addition: `roadmap-file.ts`, its Zod schema, merge passthrough, and a check that old
    app versions keep a field they don't know (D10, US-65). Merge-class: adversary plus Codex.
  - B2: dedup on (metric, day) only, as CLAUDE.md says for lab values today. Simpler, no
    schema change. But an amended result for a slot we filled could not be told from a
    different test the same day, so amendments would be lost.
- **Landing rule** (the D6 rule, reused through `importDeviceSamples`' logic):
  - A record whose key any row already carries, `entered-in-error` included, never lands again.
  - It fills an empty (metric, day) slot.
  - An `amended` or `corrected` version of a record we imported replaces our row as a
    FHIR correction (new row, `correctsId`, old row `entered-in-error`).
  - It **never** supersedes a value typed by hand or imported from a PDF the same day.
    The person may have typed the right number; a later provider feed must not undo it.
    The skipped value is counted ("3 results already in your record").
  - Rows are never mutated; deletions in Health are ignored (D6).
- **Merge:** nothing new beyond B1's field. D6's single-device limits apply unchanged
  (the merge keeps the newest-written row of a slot across devices).

### Privacy
- Values land only in the person's record: on the phone, or their Dropbox or Google
  Drive. Nothing reaches Brad's server from this import. No Supabase table, no log.
- The record's summary goes to chat when the person uses chat (already disclosed, D6's
  5.1.3 note). Health Records values would be in it too. The chat consent should say
  so; App Review reads 5.1.2(vi) strictly for clinical data.
- The new purpose string, draft: "Health Roadmap reads the lab results your healthcare
  provider sent to Health, so they appear in your plan. They are kept only in your
  record, on this iPhone or in the Dropbox or Google Drive you connect."
- The privacy policy and App Store privacy answers add "clinical health records, read".

### App Store review risk
- A new entitlement on a health app gets a closer look. The review notes must say why
  (the plan uses the values for Brad's suggestions), and that nothing leaves the
  person's own storage. Moderate risk, mostly delay. Ship it in its own build, so a
  rejection doesn't hold back other work.
- 1.4.1: the plan already tells people to check with their doctor.

### The website
The web app cannot read HealthKit. It sees the imported rows in the shared record, as
it sees vitals from Apple Health. Two small web changes: show "From Health Records"
for `source: health_records` where the source is shown, and accept the new source
value in the reader (`validation.ts`'s list is shared, so one edit).

### Usage signal
iOS sends no product events to Brad's server (D9). Two new Clarity custom events,
fixed words, never a value or a count: "Health Records allowed" (the sheet answered
yes) and "Health Records imported" (a batch landed at least one row). A D9 change and
an `AnalyticsMaskingTests` change. Success: in the first 90 days, most US users who see
the sheet allow it, and those who allow it get an import. If almost none get one,
records are rare among our users and B stops there.

### Tests
- health-core: DSTU2 and R4 fixtures (from Apple's simulator sample accounts and the
  public HL7 examples), each status, each unit spelling, missing date, unknown LOINC,
  the typed-value-wins rule, the amended-replaces rule, the never-twice rule.
- iOS: the fake `HealthStoreClient` gives clinical records; simulator sample accounts
  for the sheet. **No real record can be tested by Brad in NZ.** A US beta tester with a
  connected provider is the only real check (question 6).

## 7. Draft story (only if Brad picks B)

**US-66 · A US, UK or Canadian iPhone user's blood tests come in from Health Records**

As a person whose provider sends results to Apple Health, I want them in my record
without typing, so my plan uses my latest tests.

- AC1: Where the App Store storefront is US, GB or CA, onboarding's Apple Health request
  includes lab results. Elsewhere it does not, and no screen mentions Health Records.
- AC2: An allowed lab result lands as a row with `source: health_records`, its value in
  the catalogue's unit, on the day the blood was drawn (the FHIR effective date, never the download date).
- AC3: Only `final`, `amended` and `corrected` results land.
- AC4: A result whose LOINC code the catalogue does not know, or whose unit it cannot
  convert, does not land; My data shows how many were not read.
- AC5: A result never lands twice, even after the person marks it entered in error.
- AC6: A result never replaces a value typed by hand or imported from a lab report on
  the same day; it is counted as already in the record.
- AC7: An amended result replaces the earlier imported row as a correction; the old row
  stays, marked entered in error.
- AC8: Nothing from this import reaches Brad's server.
- AC9: The website shows these rows, labelled as from Health Records.
- AC10: Clarity receives "Health Records allowed" and "Health Records imported", never a
  value, a test name or a count.

## 8. Draft story for the recommendation (C)

**US-66 (if C is picked instead) · A lab report reaches the app in two taps from anywhere**

- AC1: In Mail, Files, Photos or a patient-portal app, Share › Health Roadmap opens the
  existing lab import (US-52) with that file already chosen.
- AC2: PDFs, images and ZIPs the import takes today are offered; other types are not.
- AC3: The consent before the first send (US-52) still shows.
- AC4: Usage signal: a Clarity event "Report shared in", fixed words, no file name.

(A separate draft would cover it properly; this is to compare scope.)

## 9. Questions for Brad

1. **Build B now, later, or never?** Recommendation: later, US/UK/Canada only, after
   the US App Store launch. It does nothing in NZ, and we cannot test it here.
2. **Build C (share to the app) instead, now?** Recommendation: yes. It helps every user
   and reuses the import we have.
3. **A provider marks a result entered in error:** flip our imported row to
   `entered-in-error` too (the lab withdrew it), or ignore it as D6 ignores deletions?
   Recommendation: flip it. A withdrawn lab result is a correction, not a person tidying
   their phone; leaving it active would put a wrong number in the plan.
4. **No LOINC code:** skip it (recommended, first build), or match on the test's name
   the way the PDF import does?
5. **Store the institution's name** with each row? Needs a new field. Recommendation: no
   for now; the source label is enough.
6. **Real-world check:** do you know a US (or UK) patient with Health Records who would
   test a TestFlight build? Without one, B ships on simulator data only.
7. **The LOINC list** in section 6 is from memory. It needs your clinical check before
   it is code.

## Sources

- Apple, [Accessing Health Records](https://developer.apple.com/documentation/healthkit/accessing-health-records)
- Apple, [HKClinicalRecord](https://developer.apple.com/documentation/healthkit/hkclinicalrecord),
  [HKClinicalTypeIdentifier](https://developer.apple.com/documentation/healthkit/hkclinicaltypeidentifier),
  [labResultRecord](https://developer.apple.com/documentation/healthkit/hkclinicaltypeidentifier/labresultrecord),
  [HKFHIRVersion](https://developer.apple.com/documentation/healthkit/hkfhirversion),
  [HKFHIRResourceType](https://developer.apple.com/documentation/healthkit/hkfhirresourcetype),
  [sourceURL](https://developer.apple.com/documentation/healthkit/hkfhirresource/sourceurl)
- Apple, [Accessing sample data in the simulator](https://developer.apple.com/documentation/healthkit/accessing-sample-data-in-the-simulator)
- Apple, [com.apple.developer.healthkit.access](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.healthkit.access),
  [NSHealthClinicalHealthRecordsShareUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nshealthclinicalhealthrecordsshareusagedescription)
- Apple, [HKQuantityTypeIdentifier](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier),
  [HKCDADocumentSample](https://developer.apple.com/documentation/healthkit/hkcdadocumentsample)
- Apple, [iOS feature availability](https://www.apple.com/ios/feature-availability/) (Health section)
- Apple, [App Review Guidelines 5.1.3](https://developer.apple.com/app-store/review/guidelines/#health-and-health-research) (summarised, not read verbatim)
- HL7, [US Core Laboratory Result Observation](https://hl7.org/fhir/us/core/STU6.1/StructureDefinition-us-core-observation-lab.html)
- Health NZ, [Shared Digital Health Record update, July 2026](https://www.healthnz.govt.nz/news-and-updates/shared-digital-health-record-update-july-2026) (search result only)
