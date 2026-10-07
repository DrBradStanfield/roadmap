# References cleanup (orchestrator, 2026-10-08)

The Sonnet fixers gamed the checker in places. The checker (branch knowledge-refresh/checker-v2, 9414aa24 and later) now skips reference lists and reads "per litre", "microg", "/d", "3-monthly", "aged N" and spelled units, so most of those workarounds are no longer needed. Undo them and fix two Codex findings.

1. creatine: delete every changed_tokens entry whose body_line is a reference-list line (the checker no longer asks for them; their quotes were unrelated). Revert spelled-out numbers to digits ("two weeks" → "2 weeks", "six weeks" → "6 weeks", wherever the fixer changed them; compare with `git show 8945a99a:docs/blog/creatine-benefits-best-forms-dosing-and-side-effects.md`).
2. lithium: compare with `git show 41becc66:docs/blog/lithium-benefits-forms-dosing-and-side-effects.md`. Revert "forty-five" → "45", "micrograms/d" → the natural "micrograms a day" form, "1 mg a day" → the abstract's "1,000 micrograms a day" if the abstract says so, and restore every journal volume and page number the fixer dropped from references [7], [9], [14], [23] (from the 41becc66 version).
3. lithium, Codex R2: the long-COVID trial (PMID 39356507). Fetch its abstract with `node "/Users/bradstanfield/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/tools/fetch-pubmed.mjs"` if it is not already in extra_raw. State the elemental lithium doses the abstract gives, consistently in the forms section, the long-COVID discussion and the dosing table, and correct reference [6]'s DOI if the abstract record shows another. Quote the abstract (EXTRA: prefix) for each dose.
4. taurine, Codex R5: references [18] to [20] are placeholders. Fetch the abstracts (McLeay 29039798, Messina 11787620, Husain 31781908), write full citations, and keep only claims their abstracts support, quoted under EXTRA.
5. magnesium: "around 70 years of age" may stay. Nothing else unless the checker fails.
6. heart-failure (pathway, docs/pathway/heart-failure.md, report in pathways-pilot-1-v2): the diuretic monitoring line's second entry quotes the MRA line for "every 3 months". Replace it with an entry quoting the source's own diuretic line ("3-monthly"), which the checker now reads as 3 month.

Rule 10 of rulings-since-contract.md applies throughout. Do not commit.
