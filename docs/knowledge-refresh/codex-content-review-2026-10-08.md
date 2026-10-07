# Codex content review of the batches branch (2026-10-08)

gpt-6.1-sol reviewed main..41becc66 (all four batches, no raw included, so INCOMPLETE as a source-fidelity review). Orchestrator rulings:

- R1 ACCEPTED, parked batch new-1: analgesia-in-children-with-acute-pain gives a post-tonsillectomy tramadol dose for 12 to 17-year-olds. Medsafe (June 2020) contraindicates tramadol after tonsillectomy or adenoidectomy under 18. Fix before new-1 review: state the contraindication, remove the dose.
- R2 ACCEPTED, references-1: lithium long-COVID trial (PMID 39356507) used 5 mg elemental lithium capsules, 2 or 3 daily, and 40 to 45 mg in follow-up; the entry says 0.383 to 1.7 mg. Fix from the abstract; correct reference [6] DOI to 10.1001/jamanetworkopen.2024.36874 if the abstract confirms it.
- R3 ACCEPTED, parked batch new-1: inflammatory-bowel-disease-ibd gives faecal calprotectin as 50 micrograms/L; docs/pathway/calprotectin.md uses micrograms/g. Check the raw; if the raw says /L, FOR BRAD.
- R4 ACCEPTED: each batch's Codex content review runs with its raw sources, abstracts and reports included.
- R5 ACCEPTED, references-1: taurine references [18] to [20] are placeholders awaiting PubMed (McLeay 29039798, Messina 11787620, Husain 31781908). Fetch the abstracts, keep only supported claims.
- R6 ACCEPTED: answer fixtures (AC5) for every refreshed handle must be registered before sign-off; the 2026-09-29 fixtures were lost with the scratchpad.
- R7 PARTLY ACCEPTED: removals ruled 2026-09-29 stay, recorded in exceptions files; US-42 AC4 is amended to say so.
- R8 DISPUTED: the drafts are on branch knowledge-refresh/batches, not main; only main deploys. AC8 sign-off gates the merge.
