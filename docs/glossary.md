# Glossary: one word per concept

The product had drifted into several words for the same thing: "erase", "delete" and "wipe"; "lab value", "blood test"
and "bloodwork"; "this device" and "this browser". This file names the word to use for each concept, the words it
retires, and the distinctions that stay on purpose. Use it when you write copy, guides, docs, comments or code names.

**Status.** Each entry is **Agreed** (the word to use from now on) or **Proposed, pending Brad**. A pending entry
covers a choice only Brad can make (his name, clinical wording, house spelling, the product's name). Until he decides,
leave existing text as it is and do not move it either way. All 30 entries are agreed: Brad answered the last eight
(G1, G4, G11, G12, G17, G26, G27, G28) on 2026-11-26, and each of those records his answer.

**Lines that change only with Brad's yes.** Some text is fixed on purpose even where an entry retires its word:
clinical text (the three-file sync in CLAUDE.md), wording Brad approved or froze, strings a test pins, and the
connector's published text (tool names, descriptions and instructions, pinned by `app/lib/mcp-freeze.test.ts`). Bring
those to Brad rather than changing them in a sweep.

**Two kinds of code name.**

- *Internal names* (local variables, functions, types, file names, CSS classes, test names) follow the entry's code
  word.
- *Stored or published names* (record keys, database columns, browser and Keychain storage keys, MCP tool names and
  text, product event names, routes, the iPhone engine contract) are listed and kept. Renaming one needs a migration
  or alias, breaks older iPhone builds that read the same cloud file, changes the connector's published bytes, or
  splits analytics history. Rename one only with Brad's OK and a migration plan.

**Left as written:** the blog (`docs/blog/`), dated docs (`docs/untangle/`, `docs/drafts/`, `docs/reviews/`, and files
with a date in their name), other archives (`docs/knowledge-refresh/`, `docs/chat-question-archive/`,
`docs/examples/`), the story records in `docs/user-stories.md`, and `CHANGELOG.md`. `docs/chatbot/` is generated
elsewhere; never edit it.

**The check.** `node scripts/glossary-words.mjs` counts a few retired words where their entry retires them and fails
when a file uses one more often than `scripts/glossary-words-baseline.json` records; a count that falls passes. To tighten
the record by hand after a fix, run it with `--write`; it refuses to raise one, and fills in a new rule's first counts (so a rule deleted from the JSON is
re-seeded at today's count; review baseline diffs). Each rule names its entry, and `scripts/glossary-words.test.ts`
checks that the word is in that entry's Retired list here. Add a rule only for a word that is wrong nearly everywhere
it is scanned; it does not read comments, identifiers or tests.

## G1. The product's name (Agreed)
- **Use:** Health by Dr Brad. **Means:** the whole product: the website, the iPhone app and the connector people add
  to their AI assistant. **Answer:** Brad, 2026-11-26: go with your recommendations; option A.
- **Retired:** "Health Roadmap" (in prose people read, except where Apple shows the iPhone app's name); "health
  roadmap" in lower case ("Your health roadmap"); "Roadmap" as a name; "Health Plan by Dr Brad" (except the cloud
  folder names); "Brad's roadmap" (the guideline pages in `docs/guideline/`; Brad's lines); "Health Plan" as the
  tool's name, if Brad says the hero heading should change.
- **Keep:**
  - The iPhone display name is "Health Roadmap" (`ios/HealthRoadmap.xcodeproj/project.pbxproj`). iOS Settings, Apple
    Health and Apple's permission dialogs show it, so a line that sends people there says "Health Roadmap" until the
    display name changes.
  - The cloud folders "Health Plan by Dr Brad" and "Apps/Health Plan by Dr Brad"
    (`packages/health-core/src/drive-rest-files.ts`, `import-hints.ts`). People have files there, and the Drive folder
    was renamed once already (US-09 AC40).
  - The hero heading "Get Your Personalized Health Plan" (`extensions/health-tool-widget/blocks/app-block.liquid`,
    `widget-src/standalone/index.html`, test-pinned) shows on every store and on GitHub Pages. Brad says whether it
    stays.
- **Code word:** "roadmap" stays (`HealthRoadmap`, `health-roadmap.json`). People read "Health by Dr Brad". The same
  word is in the stored file name and storage keys, so renaming only internal names would leave code calling its own
  file by another name. `health_roadmap_algorithm.md` keeps its name.
- **Stored names:** the file `health-roadmap.json`; browser keys `health_roadmap_*`; the cloud folders; the iPhone
  display name; the Shopify asset `health-plan-v2.css`. The MCP server name `health-by-dr-brad` already matches.

## G2. The button that starts an upload (Agreed)
- **Use:** Add medical records. **Means:** the button and screen title a person uses to give the product lab reports,
  scan results or clinic letters.
- **Retired:** "Upload lab results" and "Upload your lab results" (the web button and its tooltip); "Upload Health
  Records" (the web upload title; it collides with Apple's Health Records and with G8); "Add a lab report" (the iPhone
  tour tip, Brad's text, so only with his yes); "Upload a report" and "upload a file" as a button.
- **Keep:**
  - Brad ruled that "the feature is 'medical records'" and set the iPhone button and sheet to "Add medical records"
    (US-52 AC13c). That criterion left the web's sources as they were, so the web label was never brought in line.
  - In body text "lab report" stays the word for the common case (G15). Only the button and title say "medical
    records".
- **Code word:** "upload" (`UploadModal`, `LabUploadSheet`, `useUploadFlow`), the verb G16 picks.
- **Stored names:** events `upload_started`, `upload_saved`, `upload_outcome`, `upload_review`,
  `upload_extract_failed`; engine doors `uploadStartJson`, `uploadStepJson`, `uploadViewJson`, `uploadSaveJson`,
  `uploadSavePlanJson`; routes `/api/lab-import-v2` and `/api/app/v1/lab-import`.

## G3. Deleting saved data (Agreed)
- **Use:** delete. **Means:** removing a person's saved data, at their request, so the product no longer shows or uses
  it.
- **Retired:** "erase" in copy ("are erased", "An erase is already running."); "wipe" (absent from copy; keep it out);
  "purge" in copy, except for the server's automatic 30-day chat clean-up.
- **Keep:**
  - "Delete" overclaims in one place. With a cloud connected the iPhone says "The file stays there with your values
    erased from it" (`ios/HealthRoadmap/MyData/EraseText.swift`): the values go, the file stays. Say what happens
    ("removes your values from the file in Dropbox; the file stays"), not "deletes your record in Dropbox".
  - "Purge" is the server blanking chat text after 30 days with no request (`app/lib/chat-purge-cron.server.ts`).
  - "Clear" empties one field. "Remove" takes one item off a list ("Remove the date"). Both stay.
  - The iPhone erase-result text Brad approved (US-72 AC16) changes only with his yes.
- **Code word:** "erase" stays for the whole-record mechanism (`useErase`, `DataEraser`, `EraseText`, `eraseAll`,
  `erase-copy.ts`). People read "delete". In code "delete" already means removing one item (`deleteDocument`,
  `deleteConversation`), and the stored keys say erase. Purge names stay for the chat clean-up.
- **Stored names:** record keys `eraseEpoch`, `erasedRows`, `erasedAt`; browser keys `health_roadmap_cleared_erase`,
  `health_roadmap_local_erase_generation`; engine doors `cloudErase`, `cloudEraseHeld`, `erasePhoneJson`.

## G4. A blood test and its result (Agreed)
- **Use:** blood test (the test) and result (its number). **Means:** a test done on a blood sample; its result is the
  number the lab reported for it on one day. **Answer:** Brad, 2026-11-26: go with your recommendations; option A.
- **Retired, in copy:** "lab value"; "lab test"; "lab result" (except inside the G2 and G15 labels); "labs" as a noun;
  "bloodwork" and "blood work"; "blood result"; "blood value"; "lab work"; "biomarker" (citations and history keep
  it).
- **Keep:**
  - The catalogue holds three urine tests (Urine ACR, Urine creatinine, Urine PCR,
    `packages/health-core/src/lab-catalog.ts`). That is why the code says "lab", and why "blood test" is not strictly
    true for those rows. Option A accepts them as a known misfit.
  - The cloud folder "Lab results/" (`document-path.ts`). Renaming it moves where files go.
  - Title case "Blood Test Results" becomes sentence case "Blood tests". That is casing, not a new word.
- **Code word:** "lab" stays: "lab value" for one saved result, "lab test" for a kind of test, matching the stored
  `labValues`. Screen components named after the "Blood tests" heading keep "BloodTest" (`BloodTestTimeline`,
  `AddBloodTestSheet`). Data helpers that say "blood test" take the lab form (`isBloodTestKey` to `isLabKey`,
  `bloodTestKeyOf` to `labKeyOf`, `moveBloodTest` to `moveLabValue`, `blood-tests.ts` to `lab-values.ts`), and the web
  dialog `AddLabTest`, whose screen says "Add a blood test", becomes `AddBloodTest` to match the iPhone.
  `bloodTestHistory` and `labValueHistory` hold different lists and both stay.
- **Stored names:** record key `labValues` and row type `FileLabValue`; plan category `bloodwork`; MCP tools
  `add_lab_values` and `add_todays_results`; events `blood_test_moved`, `blood_tests_unified`, `lab_row_added`,
  `lab_rows_viewed`; engine doors `labReviewJson`, `labSaveSummaryJson`, `labSearchJson`, `cloudLabImport`; the iPhone
  analytics event "Blood test added".

## G5. Blood tests outside the core set (Agreed)
- **Use:** Additional blood tests. **Means:** the blood tests the plan does not read directly (ferritin, vitamin D and
  the like), as opposed to the core tests it does read.
- **Retired:** "additional labs" and "additional lab tests" (the headings "Additional lab results", "Additional Lab
  Results" and "Additional Lab Values"); "extra tests" and "extra blood tests"; "other blood tests".
- **Keep:**
  - "Other tests" (`lab-series.ts`) is a narrower group: tests the catalogue does not know. It stays.
  - "Core" is a code and docs word (`core: true`). People never see it; the user guide says "the main blood tests".
  - "Lab rows" is fine in code.
- **Code word:** already matches (`AdditionalLabRows`, `additionalRows`, CSS `review-additional`).
- **Stored names:** the extraction output contract `additionalValues` and `AdditionalLabValue`
  (`packages/health-core/src/lab-extraction.ts`). Changing them changes what the model is asked to return.

## G6. Screen and tab names (Agreed)
- **Use:** My health (the tab); Settings (the place), shown as the Account tab on a phone-width web page. **Means:**
  "My health" is the main tab in both apps; "Settings" is where a person changes their details, storage and
  preferences.
- **Retired, in current docs:** "My data"; "My plan". Old acceptance criteria stay as history.
- **Keep:**
  - On a phone-width web page the settings are a tab named "Account" (Brad, US-62 AC34). Desktop web and the iPhone
    say "Settings". "Account" is a decided exception, not drift.
- **Code word:** "My health". The tab was renamed for people, so internal "My data" names are leftovers: `MyDataView`
  to `MyHealthView`, `MyDataRows` to `MyHealthRows`, `my-data.ts`, `my-data-rows.ts` and `my-data-forms.ts` to
  my-health names, and the folder `ios/HealthRoadmap/MyData/` to `MyHealth/` (its own PR, since it moves the Xcode
  project file). `accountEmail` means the cloud account's email and stays.
- **Stored names:** `myData` is a key of the iPhone engine contract (`ios/engine/entry.ts`, `contract.ts`,
  `HealthEngine.swift`), so it stays until Brad agrees a migration. The iPhone analytics screen name `myHealth`
  already matches.

## G7. Telling a person a save failed (Agreed)
- **Use:** Not saved, then the reason. **Means:** the first words a person sees when what they tried to save was not
  saved, followed by why and what to do.
- **Retired:** "Could not save" and "couldn't save"; "Save failed"; "Nothing was written" in lines a person reads (for
  example the Dropbox-full hint in `packages/health-core/src/dropbox-rest.ts`).
- **Keep:**
  - "Nothing was written" stays in agent text, where it is an exact claim that no write reached storage.
  - "May have landed" is a different message: a write may have been accepted (US-31 AC8a; `LANDED_HINT`). Never merge
    it into "Not saved".
  - Where a person-facing line needs the exact claim, its plain form is "Nothing was saved."
  - "Nothing changed" on a subscription change is about the shop order, not the record.
  - Shared health-core lines that the connector also returns reach agents too; check every caller first.
- **Code word:** the message state is already `notSaved` (`NotSavedReason`, `notSavedTitle`, `NotSavedLine`). The
  iPhone's `couldNotSave` (`OnboardingFlow.swift`) becomes `notSavedText`. `saveFailed`, `SAVE_FAILED` and
  `saveFailureCause` name the failed save itself, not the message, and stay.
- **Stored names:** the iPhone analytics event "Lab review not saved opened"; refusal reasons such as `storage-full`.

## G8. The person's saved file (Agreed)
- **Use:** health record on first mention, then your record. **Means:** the one file that holds everything a person
  has saved (`health-roadmap.json`), wherever it is stored.
- **Retired:** "your file" and "the file" meaning the record (in copy); "record file" (in copy and current docs);
  "roadmap file" (in current docs; code keeps `RoadmapFile`); "health data" when it means only the record.
- **Keep:**
  - "Your data" where more than the record is meant. "Delete all my data" covers the record, chat history and
    reminders.
  - "Health Records" with capitals is Apple's clinical-records feature on the iPhone, and only that.
  - Name the file `health-roadmap.json` where the person has to find it.
  - The promise sentence at the top of `docs/user-stories.md` is fixed text.
- **Code word:** `RoadmapFile` stays (the type of `health-roadmap.json`, named by its file name, G1). The iPhone's
  `RecordFile.swift` is the same concept. People read "health record".
- **Stored names:** `health-roadmap.json`; the schema `docs/health-roadmap-file.schema.json`; browser keys
  `health_roadmap_file_v2` and `health_roadmap_file_v2_rev`; MCP `read_record`. The Supabase `profiles` table is a
  shop account, not the record.

## G9. Where the record lives with no cloud (Agreed)
- **Use:** this browser (website); this iPhone (iPhone app). **Means:** the copy of the record kept in the person's
  own browser or iPhone when no cloud storage is connected.
- **Retired:** "this device" and "your device" on the web (the label "This device only" beside the picker's "This
  browser only"); "local storage" in copy ("local storage may be full"); "on this computer"; "locally" in copy.
- **Keep:**
  - On the web the copy really is per browser: a second browser on the same computer does not see it, and clearing
    browsing data deletes it. That is why "this browser" is the accurate word there.
  - Shared health-core lines that both apps show keep "this device", which is true on both (`record-session.ts`).
    Check the caller before changing a shared line.
  - `localStorage` is the browser's API name.
- **Code word:** "local storage", the name of the browser feature the adapter wraps (`LocalStorageAdapter`,
  `loadFromLocalStorage`, `saveToLocalStorage`). People read "this browser" or "this iPhone".
- **Stored names:** backend id `local` in the browser key `health_roadmap_backend`; `health_roadmap_device_id`; record
  key `lastDeviceId` (which device last wrote, a different thing).

## G10. The two unit systems (Agreed)
- **Use:** Metric and US units. **Means:** the person's choice between metric units (kg, cm, mmol/L) and US units (lb,
  in, mg/dL).
- **Retired, in copy:** "conventional units" (the tooltip "Switch to conventional units" beside a button that says
  "US"); "SI units"; "metric / imperial" ("imperial" is wrong for mg/dL).
- **Keep:**
  - Code and the record say `si` and `conventional`. Clinical docs and agent text say "SI" and "conventional", the
    correct lab terms for developers, clinicians and agents.
- **Code word:** "SI" and "conventional" stay (`UnitSystem`, `detectUnitSystem`, `toConventional`).
- **Stored names:** record key `unitSystem` with values `si` and `conventional`; browser key
  `health_roadmap_unit_system`.

## G11. The plan and its parts (Agreed)
- **Use:** plan (the whole); suggestion (one item); recommendation only for what a guideline or Dr Brad recommends.
  **Means:** the plan is everything the product tells a person to do next; a suggestion is one item in it; a card is
  how one suggestion is drawn. **Answer:** Brad, 2026-11-26: go with your recommendations; option A.
- **Retired:** "roadmap" as the output ("Your health roadmap" on the iPhone welcome screen); "recommendation" for a
  product suggestion; "card" and "plan card" in copy (fine in UI code and dev docs).
- **Keep:**
  - "Recommendation" carries clinical weight on purpose. Hedged wording must never be upgraded into a recommendation
    (the agent instruction in `packages/health-core/src/plan.ts`), and US-25 AC28a sets the guideline voice.
  - Brad's frozen screening words say "Dr Brad recommends". They stay.
  - "Screening recommendations based on your age and sex." may be guideline voice on purpose. Brad says.
  - "Next Steps" becomes "Next steps" if Brad agrees. That is casing.
- **Code word:** already matches (`Suggestion`, `generateSuggestions`, CSS `suggestion-card`); "card" is the UI word
  in code (`PlanCard`, `PlanCardView`).
- **Stored names:** record keys `suggestions` and `recommendationSnapshots` (the second uses "recommendation" for
  product suggestions; it stays as a stored name); MCP `get_plan` and `summarise_my_plan`.

## G12. How the doctor is named (Agreed)
- **Use:** Dr Brad (no full stop); Dr Brad Stanfield for a formal first mention. **Means:** how the product names the
  doctor behind it. **Answer:** Brad, 2026-11-26: go with your recommendations; option A.
- **Retired:** "Dr. Brad"; "Dr. Brad Stanfield" (for example the chat system prompt); "Dr Stanfield" and "Dr.
  Stanfield" in chat prompts.
- **Keep:**
  - "Brad Stanfield" alone in citation author lines and in the ownership line ("Brad Stanfield founded and owns the
    company...", `us-products.ts`, test-pinned).
  - "Brad" for the maintainer in contributor docs, a different role.
  - `docs/about-page-copy.html` is Brad's own About page in his first person; his words stay as he wrote them
    (`docs/writing-style.md` section 4).
- **Code word:** none; no identifier holds the doctor's name.
- **Stored names:** the GitHub owner `DrBradStanfield`; the MCP server name `health-by-dr-brad`.

## G13. The person's own cloud storage (Agreed)
- **Use:** the service's name (Google Drive, Dropbox, GitHub); otherwise your cloud storage. **Means:** the person's
  own online storage where their record can live.
- **Retired, in copy:** "provider" on its own ("Reconnect the provider"); "cloud provider"; "storage provider"; "cloud
  account"; "backup" where it means connecting a cloud ("Back up your record" in the iPhone cloud prompt).
- **Keep:**
  - "Provider" also means a healthcare provider in health text ("discuss with your healthcare provider").
  - "Backup" stays for iCloud device backups and the command-line tool's `.bak` copies.
  - "Your cloud" as a short label where space is tight (the iPhone sync diagram), and "your cloud folder" where the
    folder itself is meant.
- **Code word:** "provider" stays for the storage service, as the stored key does (`CloudProvider`, `sync-provider`).
  The iPhone cloud-prompt names that call connecting "back up" are renamed: `backUp` to `connectChosen`,
  `backUpTapped` to `connectTapped` (`ios/HealthRoadmap/App/FirstRun.swift`). `lastBackup` and `BACKUPS_KEPT` are real
  file backups and stay. `McpProvider` is the connector's sign-in, a different thing.
- **Stored names:** record key `provider` with values `google-drive`, `dropbox`, `github`; the iPhone analytics event
  "Cloud prompt back up".

## G14. Linking cloud storage (Agreed)
- **Use:** connect (link storage); sign in and sign out (a provider's or the shop's own login). **Means:** connecting
  links the product to the person's cloud storage; signing in is what they do on Google's, Dropbox's or the shop's own
  page.
- **Retired:** "log in" and "logged in" (in copy and current docs, for example the CLAUDE.md line that defines "Logged
  in" as a connected cloud); "Log off" as a button.
- **Keep:**
  - The iPhone already keeps the two steps apart: "Connect Dropbox" and "Sign in to Dropbox again"
    (`WelcomeView.swift`).
  - "Sign in" for the Shopify customer account is a third, separate login ("For orders and subscriptions, sign in to
    your account.").
  - The web button "Log off this device" does more than sign out: it leaves the cloud and clears this browser's copy.
    Its new label has to say that; the label is not decided yet, and the string is test-pinned, so it changes with
    Brad's yes.
- **Code word:** follows the entry. `isLoggedIn` (the shop login in `chatbot-embed.tsx`) becomes `isSignedIn`. The
  "log off" names (`logOff`, `logOffId`, `listenForOtherTabsLogOff`) take the verb of the button's new label once it
  is decided. `signIn` and `sign-in-state.ts` already match.
- **Stored names:** browser keys `health_roadmap_log_off_id` and `health_roadmap_log_off_signal`; the Shopify
  parameter `logged_in_customer_id`; the theme attribute `data-logged-in`; events `signin_opened` and
  `cloud_connect_*`.

## G15. The files a person gives the product (Agreed)
- **Use:** lab report (a blood test report); document (any saved file). **Means:** a document is any file the product
  keeps for the person; a lab report is the most common kind.
- **Retired:** "results letter"; "test results document".
- **Keep:**
  - "Medical records" only in the G2 button and title. Body text says "lab reports and clinic letters".
  - "Health records" is not used for uploads (it is G8's word and Apple's feature name).
  - The cloud folders "Lab results", "Scans", "Clinic letters" and "Other documents" (`document-path.ts`). People have
    files there. "Scan results" there means imaging (DEXA, CT), not a camera scan.
  - "PDF" where the format matters ("one PDF or photo").
- **Code word:** already matches (`FileDocument`, `DocumentType`, `document-path.ts`; `labReport` in
  `upload-known.ts`).
- **Stored names:** record key `documents`; document types `scan_result`, `clinic_letter`, `discharge_summary`,
  `pathology_report` (a lab report in the record), `vaccination_record`, `other`; MCP `import_documents` and
  `file_results`; the cloud folder names.

## G16. Giving the product a file (Agreed)
- **Use:** upload (the person gives a file); read (what the AI does with it). **Means:** uploading is giving the
  product a file; reading is the AI finding the test results in it.
- **Retired, in copy:** "extract" ("Upload health records to automatically extract blood tests"); "import", except for
  Apple Health Records and the connector's `import_documents`; "add a file" and "attach".
- **Keep:**
  - "Import" for Apple Health Records on the iPhone and for an AI assistant pulling files with `import_documents`.
  - "Scan" for the iPhone camera source.
  - "Extract" in agent text.
  - On the iPhone the button verb is "Add" (G2); "upload" is still the word in sentences.
- **Code word:** "import" and "extract" stay (`labImport`, `import-review.ts`, `lab-extraction.ts`,
  `UnifiedExtractionResult`, `extractFromPdf`). People read "upload" and "read".
- **Stored names:** record sources `lab_import` and `lab_import_edited`; routes `/api/lab-import-v2`,
  `/api/app/v1/lab-import`, `/api/app/v1/lab-read` (shipped iPhone builds call them); MCP `import_documents` and
  `import_my_lab_files`; the iPhone consent id `consent.labUpload.v1`; events `upload_*`.

## G17. The person's basic facts (Agreed)
- **Use:** About you. **Means:** the section that holds the facts the plan needs first: sex, birth year, height and
  the like. **Answer:** Brad, 2026-11-26: go with your recommendations; option A.
- **Retired:** "starting info" and "starting information" (the web heading during first fill); "your details" and
  "personal details" (optional: prompts could name the section, "Fill in About you").
- **Keep:**
  - Brad chose "About you" at both stages. Today the web heading reads "Starting info" while the section sits at
    the top during onboarding, and "About you" once it moves into Settings (`aboutYouLow`; US-62 AC12, AC28 and AC31).
    Those criteria describe the switch, so the PR that changes the onboarding heading updates them too.
  - "Profile" stays in code and agent text. The Supabase `profiles` table and Klaviyo profiles are shop and email
    accounts, never the record.
- **Code word:** "profile" stays for the record's section. With "About you" at both stages,
  `StartingInfoVitals` becomes `AboutYouVitals`; `AboutYou`, `aboutYouLow` and `openAboutYou` already match.
- **Stored names:** record key `profile` and type `RoadmapProfile`; MCP `update_profile`; chat tool
  `propose_profile_edit`; event `chat_profile_edit`.

## G18. One saved number (Agreed)
- **Use:** value (one saved number); reading (blood pressure and Apple Health only). **Means:** one saved number for
  one thing on one day, such as a weight of 80 kg on 3 March.
- **Retired:** "entry" and "entries" in copy ("entries in your record could not be read"); "data point"; "measurement"
  in docs except for weight, waist or blood pressure (since US-66).
- **Keep:**
  - "Reading" for blood pressure and Apple Health samples, which is normal clinical English.
  - "Vitals", "row" and "sample" as code and docs words.
  - In docs and code "measurement" means weight, waist or blood pressure only. Since US-66 every blood test is a lab
    value.
- **Code word:** "measurement" and "lab value" stay, matching the two stored arrays (`FileMeasurement`,
  `addMeasurement`, `measurement-history.ts`). "Entry" is fine in code as the word for a form (`ValueEntrySheet`).
- **Stored names:** record key `measurements`; MCP `add_measurement`; events `measurement_added` and
  `measurement_refused`; route `/api/measurements`; Apple Health `sample` types.

## G19. The AI the person talks to (Agreed)
- **Use:** Chat (the in-app feature); your AI assistant (ChatGPT or Claude used with the connector); connector (the
  link between them). **Means:** Chat is the AI conversation inside the product; the person's own AI assistant is a
  separate product that reads their record through the connector.
- **Retired, in copy:** "AI" as the actor where the vendor is known ("The AI could not read this file." beside "Claude
  declined to read this file"); "chatbot"; "bot"; "MCP server"; "agent".
- **Keep:**
  - "Claude" where the reader needs the vendor (the upload consent and refusal lines already say it).
  - The chat names itself differently per store on purpose: "Dr Brad's AI assistant" on drstanfield.com, and the brand
    posture on microvitamin.com, which says it is not Dr Brad. These are Brad's compliance rules.
  - "Chatbot", "bot", "MCP server" and "agent" stay developer words in contributor docs. In developer docs "agent" can
    mean any automated client, not the person's assistant; read each use before changing it.
- **Code word:** "chatbot" and "assistant" stay (`chatbot-embed.tsx`, `assistantText`, CSS `chat-message--assistant`,
  the role name the model APIs use).
- **Stored names:** the Shopify theme block `chatbot-embed.liquid`, the asset `health-chatbot-embed.css` and the DOM
  id `health-chatbot-embed-root` (merchant themes reference them); MCP tool names and text.

## G20. The browser version (Agreed)
- **Use:** the website, when set against the iPhone app; otherwise the product's name (G1). **Means:** the browser
  version of the product, on drstanfield.com, microvitamin.com or GitHub Pages.
- **Retired, in copy:** "the tool" and "this tool"; "roadmap tool"; "health tool" (fine in code and dev docs); "web
  app"; "widget"; "tool page" and "roadmap page".
- **Keep:**
  - "Widget", "storefront" and "health-tool" stay Shopify and developer words (`health-tool-widget`,
    `health-tool-root`).
  - The iPhone disclaimer "This tool is for educational purposes only..." (`ios/HealthRoadmap/Plan/Plan.swift`) may be
    wording Apple review accepted. Brad says before it changes.
  - Where the replacement would be the product's name, wait for G1.
- **Code word:** "health tool" and "widget" stay, the Shopify names (`HealthTool`, `widget-src`).
- **Stored names:** the extension `health-tool-widget`; the DOM id `health-tool-root`; `utm_source=health-tool` in
  saved links; the asset `health-widgets.css`; events `waist_widget_saved` and `bp_widget_saved`.

## G21. The native app (Agreed)
- **Use:** the iPhone app. Inside the app, copy just says "the app". **Means:** the native app on the iPhone.
- **Retired:** "iOS app" (in prose); "mobile app"; "phone app"; "native app".
- **Keep:**
  - "iOS" for the platform and in code (`ios/`, iOS versions).
  - In contributor docs "the app" can also mean the Shopify app; say which.
  - The line in `health_roadmap_algorithm.md` is one of Brad's clinical files, so he reviews its edit.
- **Code word:** already matches; no internal name says "iOS app".
- **Stored names:** none.

## G22. Fixing a wrong value (Agreed)
- **Use:** correct (the verb); Replace (the button for a value already saved that day). **Means:** fixing a saved
  value that was wrong; the old value stays in the record, marked as a mistake.
- **Retired, in copy:** "entered in error" ("struck through and marked as entered in error"); "fix" a value; "mark as
  wrong" or "mistake" as the verb ("kept as a mistake" is fine as a description).
- **Keep:**
  - "Entered in error" is the FHIR status and stays in agent and dev text.
  - "Replace" stays the button when a value already exists for that day.
  - "Edit" is a different thing: chat edit proposals and profile edits.
- **Code word:** already matches (`correctValue`, `onCorrect`, `CorrectFn`; `replaceLabel`, `canReplace` for the
  button).
- **Stored names:** record key `correctsId`; status `entered-in-error` (the FHIR status); source `manual_correction`;
  MCP `correct_value`; event `correction_made`.

## G23. Saved chats (Agreed)
- **Use:** conversation (one chat); chat history (all of them). **Means:** a conversation is one chat; the chat
  history is every saved conversation.
- **Retired, in copy:** "thread"; "chat log" and "transcript"; "past chats" and "your chats".
- **Keep:**
  - The iPhone list of past chats is titled "History" (`ChatHistoryList.swift`). Where history also means a value's
    past readings that is ambiguous; "Chat history" is the proposed title.
- **Code word:** follows the entry. The web's "thread" names become chat-history names to match the iPhone:
  `ChatThreadList` to `ChatHistoryList`, CSS `chat-thread-item` to `chat-history-item`, the chat step `open-thread` to
  `open-conversation`. `conversationId`, `ChatHistoryStore` and `chat-history.ts` already match. `ChatTranscript` (the
  iPhone's on-screen conversation) stays, because `ChatConversation` already names a saved one.
- **Stored names:** Supabase tables `chat_conversations` and `chat_messages`; column `conversation_id`.

## G24. The day of a blood test (Agreed)
- **Use:** day of the test. **Means:** the day the sample was taken, which is the day a result belongs to in the
  record.
- **Retired:** "test date" and "date of the test" ("PSA test date" could become "Day of the PSA test"); "drawn" and
  "draw date" in copy (none today; keep them out).
- **Keep:**
  - Model and agent text say "collection date" and "sample date" on purpose. Lab reports print those words, and the
    model must not use the print date (`lab-extraction.ts`).
  - Stories and comments may say "drawn".
- **Code word:** follows the stored key (`recordedAt`, `resolveRecordedAt`, `buildRecordedAt`).
- **Stored names:** record key `recordedAt`; MCP parameter `collectedOn`.

## G25. Apple's health data (Agreed)
- **Use:** Apple Health. **Means:** Apple's built-in health data on the iPhone that the app reads and writes.
- **Retired, in copy:** "HealthKit" (absent today; keep it out); "Health app" and "the Health app", except in
  step-by-step directions inside iOS.
- **Keep:**
  - The bare app name "Health" ("come in from Health", `AppleHealthSection.swift`) becomes "Apple Health". The app
    really is called Health, but beside the general word health it reads oddly.
  - "HealthKit" stays the developer framework name, and the name of Apple's documentation in citations.
- **Code word:** already matches (`HealthKitClient` wraps the framework; `AppleHealthSync`, `AppleHealthSection`).
- **Stored names:** record sources `apple_health` and `health_records`.

## G26. Medicines (Agreed)
- **Use:** medicine in sentences; Medications in form titles; drug only for drug names and classes in clinical text.
  **Means:** a prescribed medicine the person takes. **Answer:** Brad, 2026-11-26: go with your recommendations;
  option A.
- **Retired:** "meds" in copy; "medication" in sentences.
- **Keep:**
  - Brad's approved education line says "medicines": "Talk to your doctor before you change anything about your health
    or medicines." (`ios/HealthRoadmap/App/EducationNote.swift`, US-25 AC10b).
  - Form titles say "Medications" ("Cholesterol Medications").
  - Clinical text says "drug" for classes and names; the form error says "Drug name is required".
  - "Treatment" and "prescription" mean different things.
- **Code word:** "medication" stays, as the stored keys do. The one function that says "medicines", `medicinesShown`
  (`suggestions.ts`), becomes `medicationsShown`.
- **Stored names:** record keys `medications`, `medicationHistory`, `medicationKey`, `drugName`; chat tool
  `propose_medication_edit`; event `medication_history_viewed`.

## G27. Names of individual tests (Agreed)
- **Use:** one display name per test (ApoB, Lp(a), HbA1c), taken from the code labels, with the full name beside it on
  first mention in prose. **Means:** how each test is spelled, for example ApoB, Lp(a), HbA1c, LDL cholesterol.
  **Answer:** Brad, 2026-11-26: go with your recommendations; option A.
- **Retired:** "apoB", "APOB" and "apo B" in prose; "A1c" on its own in prose.
- **Keep:**
  - The full name beside the short one on first mention is house style (`docs/writing-style.md`), for example
    "Lipoprotein(a), a cholesterol-carrying particle like LDL...".
  - Display labels already come from one place (`UNIT_DEFS` labels and `LAB_CATALOG`).
  - Any change goes through the clinical three-file sync (CLAUDE.md), all three files in one PR.
- **Code word:** identifiers follow each language's casing (`apoB`, `ApoB`, `HbA1c`, `LpaUnit`); they are not display
  names.
- **Stored names:** metric types `apob`, `lpa`, `hba1c`, `ldl`; browser key `health_roadmap_lpa_check_kept`; events
  `lpa_unit_selected` and `lpa_check_answered`.

## G28. House spelling (Agreed)
- **Use:** US spelling in everything people read. **Means:** whether prose uses US spelling (personalized, catalog) or
  NZ/UK spelling (personalised, catalogue). **Answer:** Brad, 2026-11-26: go with your recommendations; option A.
- **Retired, in copy:** "personalised"; "organised"; "catalogue" (the connector's text keeps it until its pins are
  re-taken).
- **Keep:**
  - This entry is the house spelling rule; CLAUDE.md and `docs/writing-style.md` do not state one. Brad is in New
    Zealand and the stores serve the US. Copy on the website already leans US ("personalized").
- **Code word:** code follows the house spelling. With US spelling: `mcp-tool-catalogue.ts` to `mcp-tool-catalog.ts`,
  `OFF_CATALOGUE_NOTE` to `OFF_CATALOG_NOTE`, `isLooseCatalogueName` to `isLooseCatalogName`. `lab-catalog.ts` and
  `LAB_CATALOG` already use it.
- **Stored names:** the organisation value `not_organized` (already US); the connector text that says "catalogue".

## G29. The person who uses the product (Agreed)
- **Use:** you (copy); the user (agent text); the person (stories and docs). **Means:** the person the product is for,
  named by who is reading.
- **Retired:** "user" in copy, where a sentence talks about the reader in the third person.
- **Keep:**
  - Each of these is a different role and stays: "customer" is the Shopify account holder (`logged_in_customer_id`);
    "visitor" is the anonymous analytics id (`visitorId`); "guest" is a person with no cloud connected (`is_guest`,
    `guest_chat_sessions`); "patient" is Brad's clinical voice ("I tell my patients"), never a product user.
  - Agent text says "the user". Prompt text in website code (the browser chat prompt) is agent text too.
- **Code word:** each code name matches its role (`userId`, `visitorId`, `isGuest`, `customerId`).
- **Stored names:** Supabase column `user_id` and table `guest_chat_sessions`; `logged_in_customer_id` and
  `shopify_customer_id`; the event field `visitorId`.

## G30. The kind of thing measured (Agreed)
- **Use:** test (a kind of blood test), or the thing's own name (weight, waist, blood pressure). **Means:** the kind
  of thing measured, as opposed to one saved number of it (G18).
- **Retired, in copy:** "core metric" ("is not a core metric", if that line reaches people); "metric"; "marker".
- **Keep:**
  - "Metric" and "core metric" stay in agent text (`mcp-tool-contract.ts`).
  - "Field" means a form input.
  - Some `record-edits.ts` messages reach only agents; check which before changing one.
- **Code word:** "metric" stays, as the stored keys do (`MetricType`, `METRIC_TYPES`, `MetricChart`, `LiveMetric`).
- **Stored names:** record keys `metricType` and `metricName`; refusal reason `unknown-metric`; the scrub list
  `SCRUB_METRIC_WORDS`.
