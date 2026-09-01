# Reading and writing a health record with an AI agent

Your health record is one file: `health-roadmap.json`. It lives in **your** storage —
your Dropbox, your Google Drive, your GitHub repo, or your browser. It is never on our
server, so there is no API to call and no key to get. Any agent with filesystem access
can open the file, read it, and write it back.

This page is the contract for doing that safely.

- Format: JSON Schema (draft 2020-12) —
  [`docs/health-roadmap-file.schema.json`](health-roadmap-file.schema.json),
  published at
  `https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/docs/health-roadmap-file.schema.json`
- Current `schemaVersion`: **1**
- TypeScript source of truth: `packages/health-core/src/roadmap-file.ts`
- Compute the plan from the file: `npx tsx tools/get-plan.ts <file>` (in this repo) — see `--help`
- Something wrong or missing? The MCP server's `report_feedback` tool prepares a prefilled
  GitHub issue for the user to review and submit — it sends nothing itself, and no health
  value belongs in it.

## Where the file is

The file name is always `health-roadmap.json` (`ROADMAP_FILE_NAME` in
`widget-src/src/storage/adapter.ts`). Each backend scopes the app to one folder or repo,
so this is the whole footprint.

| Backend | Location | Local path with desktop sync |
| --- | --- | --- |
| Dropbox | App-folder app, so everything sits under `Apps/Health Plan by Dr Brad/` | `~/Dropbox/Apps/Health Plan by Dr Brad/health-roadmap.json` |
| Google Drive | Folder `Health Plan by Dr Brad` in My Drive | Wherever Drive for desktop mounts My Drive — on macOS usually `~/Library/CloudStorage/GoogleDrive-<email>/My Drive/`, elsewhere often `~/Google Drive/My Drive/`. Set the folder "Available offline", or Drive streams it rather than storing it |
| GitHub | Default branch of the one repo the token is scoped to, at the repo root | your clone: `health-roadmap.json` |
| WebDAV / self-host | Relative to the configured base URL | wherever you mounted it |
| Browser only | `localStorage` key `health_roadmap_file_v2` | no file on disk — export from the app instead |

Uploaded reports sit beside the JSON in human folders: `Lab results/`, `Scans/`,
`Clinic letters/`, `Other documents/`, named `YYYY-MM-DD Title.ext`. Each
`documents[].fileRef` is that path — but treat it as an opaque relative path, not
a pattern: older rows use other shapes (`documents/doc_1.pdf`), and a text-only
document has `fileRef: ""`.

## How to read

1. Parse the JSON.
2. Check `schemaVersion`. If it is greater than 1, stop — a newer app wrote this file and
   you may not understand every field. Read if you like; do not write.
3. Current values live in the arrays, not in a separate "current" object.
   - `measurements` (core metrics) and `labValues` (everything else) are **append-only
     history**. A row's slot is `(metric, calendar day of recordedAt)` — `metricType` for
     measurements, `metricName` for lab values.
   - Within a slot, at most one row has `status: "active"`. That is the current value.
     If several are active, the newest `createdAt` wins (larger `id` breaks a tie).
   - Everything with `status: "entered-in-error"` is superseded history. Keep it, show it
     if asked, never treat it as current.
4. `medications`, `supplements`, `reminderPreferences` hold current state, one row per
   key. `medicationHistory` and `supplementHistory` are the append-only logs behind them.
   `profile` and `screenings` are singletons.
5. Skip any document with `deleted: true`. The row stays in the file forever; the user
   deleted it.

## How to write — the hard rules

The file follows FHIR `Observation` discipline. Break these and you silently corrupt
someone's medical history, or lose their data at the next device sync.

1. **Never mutate a row. Never delete a row.** Not in `measurements`, `labValues`,
   `documents`, or either history log.
2. **A correction is an append.** Add a new row with a fresh id and
   `correctsId` set to the old row's id, then set the old row's `status` to
   `"entered-in-error"`. That status flip is the only edit ever permitted to an existing
   row, and it is one-way — `entered-in-error` never goes back to `active`. The
   correction row keeps the original row's `recordedAt` — a correction changes the
   value, never the date.
3. **Check the slot before you append.** Look for an active row in the same
   `(metric, calendar day)` slot. If one exists you have exactly two options: flip it to
   `"entered-in-error"` (setting `correctsId` on your new row if you are correcting it),
   or write nothing. **Never leave two active rows in one slot** — nothing reconciles
   them for you (see Caveats).
4. **If the value is already there, write nothing.** Before appending, check whether the
   active row for that slot already carries this value. Re-importing the same lab report
   is the most dangerous thing an agent can do here: fresh ids and a fresh `createdAt`
   make your rows win every slot, permanently demoting the user's originals — including
   the manual corrections they made by hand. Import is not idempotent unless you make it
   so.
5. **Fresh UUID per row, always.** Never reuse an id, never renumber. Ids are the merge
   identity across devices. Treat ids you read as opaque strings: an id containing
   `#dup-` is a quarantined duplicate the merge created after an id was reused with
   different content. Never write a `#dup-` id yourself.
6. **Leave `meta` alone — except `meta.updatedAt`, which you MUST set to now (ISO 8601),
   using the same clock as your rows' `createdAt`/`updatedAt`.** It is the anchor of the
   clamp below: leave it stale and every row you just wrote is rewound to it on the next
   load, and can lose its slot or its record to an older entry. Never touch
   `meta.lamport`, `meta.eraseEpoch`, or `meta.lastDeviceId` — they are the sync engine's
   clocks. Garbage there is clamped or reset to 0 on read, and a reset `eraseEpoch` makes
   the next merge discard your whole copy wholesale (`eraseEpoch` is what makes "delete
   all my data" stick).
7. **Touch only the rows you added.** Do not reformat, re-sort, or normalise other rows.
   Updating a current-state row you legitimately own (a medication, supplement, or
   reminder preference) means setting that row's `updatedAt` to now and leaving its
   `lamport` exactly as you found it, or absent.
8. **Units.** `measurements[].value` is the SI canonical unit — kg, cm, mmHg, mmol/mol
   for HbA1c, mmol/L for lipids, g/L for ApoB, µmol/L for creatinine, ng/mL for PSA,
   nmol/L for Lp(a). Convert before you write. `labValues[].value` keeps the lab's own
   number and its reported `unit` string verbatim; no conversion.
9. **Timestamps are ISO 8601, and never in the future.** On every load the app clamps a
   row's write-clocks — `createdAt` on measurements and lab values, `updatedAt`/`lamport`
   on current-state rows — to the file's own last write (the later of `meta.createdAt`
   and `meta.updatedAt`), so a future stamp is rewound, not rejected. `recordedAt` is
   never clamped: it is the clinical date, and a future one still puts a value on a day
   that has not happened — that mistake is yours to avoid. `recordedAt` may be
   `YYYY-MM-DD` or a full timestamp — only the day is used for slotting.
10. **Use catalogue keys for `metricName`.** If the test is in
    `packages/health-core/src/lab-catalog.ts` (ferritin, tsh, alt, …), use that `key`.
    Matching happens on those keys, so free text creates a duplicate the app cannot
    merge. Core metrics — LDL, HDL, HbA1c, creatinine and the rest — belong in
    `measurements` with a `metricType` from `METRIC_TYPES`, not here.
11. **Deleting a document** means setting `deleted: true` on its row. A removed row comes
    straight back from any other device.
12. **`reminderOptIn.token` is a capability secret.** Leave it where it is; never copy it
    out of the file.

Validate your result against the schema before you write it back.

## Caveats — read these before you automate anything

- **There is no lock and no version guard on a filesystem write.** The web app writes
  with an optimistic-concurrency check; you do not have one. Read, modify, and write back
  promptly. Do not hold the file open across a long task, and do not write while the user
  has the app open in a browser tab.
- **The merge is not a cleanup pass, and it does not run on load.** Opening the app
  reads and normalises the file; nothing reconciles slots until the app writes, which
  needs a second device or a user edit. Two active rows in one slot therefore stay
  visible. When a merge does run it never deletes — a slot loser becomes
  `entered-in-error`, and an id reused with different content becomes two rows, the extra
  one quarantined under `<id>#dup-…` — but that is a safety net for concurrent devices,
  not a licence to write sloppily. Rule 3 is yours to enforce.
- **Malformed rows may be dropped, ignored, or have their clocks rewritten.** The app
  normalises an untrusted file on every read — a non-array where an array belongs becomes
  an empty array, out-of-range counters and future write-stamps are clamped (see the
  timestamps rule), and a row missing fields the UI needs simply will not render. Beyond
  those clamps it does not repair rows, and it does not warn.
- **Unknown fields survive at the top level and inside rows** — migrate and merge both
  spread what they do not recognise, so an older app will not strip something a newer
  one added. **`meta` is the exception:** `mergeFiles` rebuilds it from its five known
  fields, so anything else you put there is dropped at the next sync. Do not use this
  file to store your own state.
- **A file with a higher `schemaVersion` than the app understands is refused, not
  downgraded** (`SchemaTooNewError`). Never bump `schemaVersion` yourself.

## No telemetry

Reading or writing this file contacts none of our servers — no sync endpoint, no
analytics hook on the file, by design. We cannot see that you did this, and we do not
want to.
