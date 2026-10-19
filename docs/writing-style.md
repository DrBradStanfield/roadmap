# Writing style — don't sound like AI (HARD, Brad 2026-08-27)

Applies to ALL prose Brad's audience reads: YouTube scripts, ads, blogs, emails, X posts, product copy, thumbnails/titles. Load this file before writing or reviewing any of those; run the self-check (bottom) before delivering.

Source: Wikipedia "Signs of AI writing" (Aug 2026), distilled to what matters for our surfaces. Complements — never overrides — the CLAUDE.md forbidden-words table, the doctor-endorsement rules, existing memories (show-don't-tell, 10-year-old language, once-and-done, no all caps), and the script-voice corpus (`brad-voice-patterns.md`, `reference-scripts.md`). **Script deference is scoped, not blanket**: on scripts the voice corpus governs only its own named exemplar patterns; em-dash density now has an explicit script budget (below) and every other rule in this file applies to scripts — "it's a voice device" is not a bypass.

**Packaging exemption:** YouTube titles (Title Case per the A/B ledger), thumbnail overlay text (all-caps house style), blog SEO titles, and email subject lines follow their own conventions — the formatting/case rules below don't apply to them. The vocabulary tiers still do.

**Important carve-out:** compliance hedges are mandatory, not AI tells. "May support," "the evidence suggests" on health claims stay. What this file bans is *filler* hedging and *decorative* significance — not legally required caution.

## 1. Banned patterns

**Significance inflation.** Never tell the reader something matters — state the fact that makes it matter. Banned phrases: "stands as", "serves as a testament", "plays a crucial/pivotal/vital role", "underscores/highlights the importance of", "marks a turning point", "reflects a broader", "evolving landscape", "paving the way", "setting the stage". (Bare "crucial"/"pivotal"/"underscore" are tier-2 vocabulary below, not bans.)
- ❌ "This trial marks a pivotal moment in cancer treatment."
- ✅ "This trial cut recurrence by 44%. Nothing else has done that."

**Tacked-on "-ing" analysis.** A sentence that ends ", highlighting / underscoring / showcasing / ensuring / reflecting / demonstrating …" — delete the clause, or make it its own sentence with a concrete fact.

**Negative parallelism.** "It's not just X — it's Y", "This isn't X; it's Y", "Not X. Not Y. Just Z." Humans use these too, but they're now stereotyped as an AI signature, so ration them: maximum one deliberate use per script; avoid entirely in ads/emails/blogs.

**Rule of three.** AI defaults every list to three parallel items. Vary deliberately: one item, two, four. Never three adjectives in a row.

**Copula avoidance.** Prefer plain "is/are/has": "the study is", not "the study serves as"; "has 26 ingredients", not "boasts/features/offers 26 ingredients". "Was the first", not "holds the distinction of being the first".

**AI vocabulary — two tiers.** The research finding is that the tell is *density and clustering*, not any single word: one of these words is coincidence, several in one piece is the signature.
- *Tier 1 — banned* (never the natural choice in our copy; fine when quoting someone): delve, tapestry, landscape (abstract), testament, boasts, nestled, garner, seamless, elevate, empower, unlock, exemplifies, "valuable insights", "align with", "resonate with", "diverse array", "in the heart of", "commitment to" (press-release staple — state the concrete practice instead).
- *Tier 2 — density-capped* (legitimate words; use when it's the *precise* word, not the reflex word): crucial, pivotal, robust, comprehensive, meticulous, showcase, foster, underscore, vibrant, profound, groundbreaking, renowned, rich (figurative — "rich history"; literal "rich in EPA" is fine), sentence-initial "Additionally/Moreover/Furthermore". Cap: ~1 tier-2 word per 500 words (short pieces still get one), never two in the same sentence. Over the cap → keep the ones doing real work, rewrite the rest in plain words. Don't contort to avoid a tier-2 word when it's exactly right.
- (Grift-word bans — longevity, wellness, optimize, anti-aging, biohacking — live in CLAUDE.md and always win.)

**Em dashes.** Claude overuses them more than professional writers do. Never use em dashes in ads, blogs, emails, X, website, and product copy. **Scripts (tightened, Brad 2026-09-02):** the voice-corpus exemption is withdrawn — video 36's draft shipped 104 em dashes in 2,790 spoken words (one every 27 words) and read as AI. Script budget: **at most 1 em dash per 250 spoken words (~10 in a 2,500-word script), never two in one sentence, none as a substitute for a full stop.** Default replacement is a full stop; second choice a comma; a colon for a reveal. Editor notes and citation blocks are exempt (not spoken). Spaced hyphens or `--` standing in for an em dash count as em dashes; quote-attribution dashes ("— Ashley A.") and numeric ranges (300–500mg) are fine. Use `node tools/check-copy-style.js --script "path/to/script.md"` for narration extraction and script-specific counts; the default CLI remains strict for ads/store/email copy. The approved write-up close may use commas instead of its paired em dashes, preserving the words and education-site destination. This resolves the template punctuation conflict without exempting other narration. Semantic style judgments still require reading the passages.

**Vague authority.** "Experts argue", "studies show", "research suggests" without the named study = ban. Name the trial, year, and number (this is already citation discipline — same rule, style angle).

**Formulaic wrap-ups.** No "In summary / In conclusion / Overall", no paragraph restating what the reader just read (once-and-done), no "Despite these challenges…" pivots, no "Future outlook" sections.

**Narrator meta vs Brad's signposts (scripts; Brad 2026-10-19).** Banned AI narrator meta: compressed aphorisms ("Supplements face the same wall"), recap stacks, "And in [year] came the X", "Here's the difference / Here's the change", one-word verdict fragments ("Encouraging."), self-praising "honest", and the staged self-correction "I had thought most of this came from cells in a dish. It didn't." Allowed, because Brad writes them himself: plain viewer-directed signposts that name the next subject, his verdict or an earlier set-up ("Which brings us to astaxanthin.", "So here's my take on Lp(a).", "Here are 5 potential explanations." (a numbered list inside one section, never in the cold open or Section 1), "But I don't think so, and here's why.", "Let's keep going to find out.", "As I mentioned earlier…"). The test: does the line name the next subject, question or verdict (allowed), or the script's structure, meaning or a recap (banned)? Don't flag Brad's signposts in a style audit.

**Hedging filler.** "It's important to note", "it's worth noting", "keep in mind", "that said". Either the point earns its own sentence or it goes.

**Formatting tells** (blogs/emails/X): no bold-header bullet lists ("**Speed:** it's fast") as a default structure — write prose; no title-case headings (sentence case); no emoji as section decoration; bold at most one phrase per screen of text.

**Elegant variation.** Repeating a word is human; rotating through synonyms ("the supplement… the compound… the formulation… the product") is a tell. Pick the word and reuse it.

**Mannered prose.** Metaphor and flourish standing in for a direct statement: "a dial worth turning" for "a parameter worth varying", "this point earns its keep" for "this point still matters", "the body's thermostat" for "the mechanism that regulates X". The phrase exists to display the writer, not to convey the idea, and it drags in connotations the writer didn't choose. Say what you mean; when a literal phrase is available, use it. (Anthropic's Fable 5.1 prompting guide names this as the model's residual tell; the one-line instruction "remove all mannered prose" works in a revision pass.)

## 2. Write like a human

- Simple verbs: use, try, help, show, find — not utilize, attempt, facilitate, leverage.
- Short declaratives and fragments are good, especially in scripts. Vary sentence length hard: a 4-word sentence next to a 25-word one.
- Concrete beats abstract every time: "2,847 patients over 6 years" not "a substantial long-term cohort".
- Commit where the evidence allows: "the trial found no benefit" — not "the findings may indicate limited efficacy". (Never-overclaim governs the ceiling; this governs the floor: don't hedge below what the data shows.)
- Opinions get an owner: "I tell my patients…" (clinical-practice voice), not "some would argue".

## 3. Self-check pass (run before delivering any draft)

1. Grep the draft for tier-1 words and banned phrases; rewrite each hit in place. Count tier-2 hits: over ~1 per 500 words, or two in one sentence, rewrite the weakest.
2. Count em dashes; thin to budget (scripts: ≤1 per 250 spoken words — narration only, excluding citation blocks and editor notes; `grep -v` them out, then `grep -o '—' | wc -l`).
3. Scan sentence endings for "-ing" tack-ons.
4. Scan for "not just… but", "isn't… it's", triplet lists.
5. Read the last paragraph: if it summarizes, cut it.
6. Read once for mannered prose: any metaphor or flourish a literal phrase could replace, replace.
7. Then run the CLAUDE.md forbidden-words scan as usual.

A draft that fails any step gets rewritten, not annotated.
