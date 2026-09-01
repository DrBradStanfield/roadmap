# Example records

`health-roadmap.sample.json` is a fictional record, made up for documentation and tests.
It belongs to nobody: the profile, the blood results, the lab value and the medication were
invented, and no part of it came from a real person. It was built through the app's own code
(`createEmptyFile` → `createMeasurement` → `mergeFiles` → `migrateFile`), so it is a valid
`schemaVersion: 1` record rather than JSON typed by hand. Copy it somewhere and point the
command-line tools at the copy while you learn them — see
[guides/command-line.md](../guides/command-line.md). Editing it in place will fail the tests
that pin the guide to it.
