New-entry addendum (pages the April build never saw; US-42 new-entry protocol).

There is no ENTRY and no OLD_RAW. You write the whole file, frontmatter included, from NEW_RAW only, using docs/pathway/gout.md as the shape.

Frontmatter you author (the only time a writer authors frontmatter):
- title: "Pathway: <Page title as the source names it>"
- type: "pathway"
- tags: ["Guideline"]
- keywords: 15 to 25 lowercase terms a patient or the router might use: the condition, its synonyms and lay names, the main drugs and tests named in the body, key symptoms. No brand names, no NZ agency names.
- summary: one paragraph, 200 to 300 characters, front-loaded: the first 150 characters must say what the pathway covers and for whom, because the router sees only the first 150. Then the main sections (red flags, assessment, management options, when to refer). End with "Always discuss with your doctor." Style: match the existing summaries in docs/blog/index.json for type pathway (read three). No em dashes.

Body rules are the contract's (1 to 13). Report: set "new": true, old_raw_path null, headings_before [], deleted_sentences [], and changed_tokens for EVERY number in the body (each with a verbatim raw quote), since every number is new. Do not touch docs/blog/index.json; the orchestrator rebuilds it.
