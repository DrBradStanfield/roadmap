---
title: "Did One Tiny Tweak Just Solve Heart Disease?"
url: "https://drstanfield.com/blogs/articles/did-one-tiny-tweak-just-solve-heart-disease"
youtube: "https://youtu.be/tvef5PqDHc0"
publishedAt: "2026-06-08T00:00:00Z"
tags: ["Research", "Preventative Care"]
keywords: ["atherosclerosis", "cardiovascular", "cholesterol", "ezetimibe", "heart attack", "ldl", "pcsk9", "statin"]
summary: "Dr Brad's VERVE-102 post: a one-time gene-editing infusion lowered LDL cholesterol by 62% in a 35-patient phase 1 trial on top of maximum-tolerated statins. Covers PCSK9 discovery, base editing vs CRISPR cutting, and the 2024 setback that nearly ended the program."
---

In April 2024, the trial that was supposed to end heart disease at the source nearly ended in disaster.

One of the initial patients to receive the world's first gene-editing infusion designed to permanently lower cholesterol was four days post-treatment when their platelets crashed and their liver enzymes spiked. They didn't have any symptoms — and within days, the lab values came back to normal. But the trial stopped. [1]

It was a bitter blow for Verve Therapeutics, who had spent the better part of a decade and nearly a billion dollars on a single idea: that you could change one letter of DNA inside the liver and make someone effectively immune to heart attacks.

But they didn't give up. They revised the approach and tried again. And last week, the New England Journal of Medicine published the encouraging results of their latest trial, using a new therapy called VERVE-102.

## The PCSK9 Detective Story

But how is the approach Verve is taking even possible? How can flipping a single letter in the DNA of liver cells virtually eliminate heart disease? Isn't it caused by a range of factors, working together?

The answer begins in Framingham, Massachusetts.

In 1948, the Framingham Heart Study began enrolling residents of a small town outside Boston and tracking what made some of them have heart attacks and others not. Over the next decades, Framingham gave us the phrase "risk factor." By now, everyone knows the most common ones — smoking, high blood pressure, obesity. [2]

But as the data accumulated, one risk factor emerged as pivotal. It's a necessary ingredient that, when it isn't present, heart disease becomes vanishingly rare. That risk factor is LDL cholesterol. [3]

And this conclusion keeps getting stronger. Across the 200+ studies, 2 million participants, and 20 million person-years that the European Atherosclerosis Society reviewed in 2017, every type of study converges on the same answer: LDL causes atherosclerotic cardiovascular disease. [4]

But unfortunately, some people have sky-high LDL cholesterol — not because of their diet or lifestyle, but because of their genes.

That's what a geneticist named Catherine Boileau stumbled upon at the Necker-Enfants Malades hospital. Boileau was studying French families with a particular kind of genetically high cholesterol — heart attacks in their 40s, LDL that wouldn't budge. She found that a gene called PCSK9 was overactive in these families. And when this enzyme was overactive, cholesterol skyrocketed.

But this raised a more interesting question.

What about people who had the PCSK9 gene cranked *down*?

Researchers in Dallas accidentally found out. In 1999, two geneticists at UT Southwestern — Helen Hobbs and Jonathan Cohen — launched the Dallas Heart Study, a project that collected DNA and medical records from thousands of Dallas residents. They were specifically looking for people whose cholesterol was unusually low. They checked the obvious genes. Nothing. Then they checked PCSK9.

And they found people whose PCSK9 gene was broken. About 2% of the African-Americans in their cohort carried a broken PCSK9 gene. Their LDL was 28% lower. Their lifetime risk of coronary heart disease was 89% lower. [5]

The cohort had smokers. It had people with diabetes. It had people with high blood pressure. The protection held anyway. [5]

The picture was coming into focus. When PCSK9 is overactive, it produces dangerously high cholesterol. But broken PCSK9 yields lifelong protection from the world's leading cause of death.

If you could turn PCSK9 off at will, you could rewrite cardiovascular medicine.

From the same 2017 European Atherosclerosis Society review we looked at earlier, we can see that a faulty PCSK9 gene reduced cardiovascular disease, with a "markedly lower lifetime risk of ASCVD." [4]

And in 2021, evidence emerged that broken PCSK9 was associated with a longer life as well. [6]

This is exactly the approach Verve Therapeutics wanted to take. There were already medications such as evolocumab that could temporarily switch off PCSK9. But what if there was a way to permanently switch it off?

Enter the gene editing tool: CRISPR. But there's a problem with CRISPR that Verve needed to overcome.

## Enter CRISPR (and How Liu Fixed It)

CRISPR's discovery begins in a yogurt factory.

In 2007, two scientists at the Danish food company Danisco — Rodolphe Barrangou and Philippe Horvath — were trying to figure out why bacterial cultures used to make yogurt and cheese kept getting wiped out by viruses. They focused on strange repeating sequences of DNA in the bacterial genome — called CRISPR — that nobody had figured out the function of. [7] [8]

What they found was an immune system. The bacteria were storing snippets of viral DNA inside those CRISPR sequences — a molecular memory of every virus that had ever attacked them. The next time the same virus tried, the bacteria used those stored snippets to recognise it and cut it apart. [9]

Five years later, in 2012, two researchers — Jennifer Doudna at Berkeley and Emmanuelle Charpentier in Sweden — built on this discovery to do something remarkable. They showed the CRISPR-Cas9 system could be reprogrammed. Give it a custom guide, and it would cut any DNA sequence you wanted, anywhere in the genome. [10]

They won the Nobel Prize for it in 2020. [11]

But there was a problem at the heart of CRISPR-Cas9. The way it works is by cutting both strands of DNA. Cells try to patch the break — but they patch it imperfectly. You can get small insertions or deletions. You can get large deletions. You can get chromosomal rearrangements where two distant pieces of DNA fuse together. [12]

It doesn't sound particularly safe for a human gene therapy.

For just disrupting a gene, this might be good enough. For most diseases — where you want to make a specific, surgical change — cutting was the wrong tool.

And the field had a haunting example of how badly DNA changes could go. In the early 2000s, a French team ran a gene-therapy trial for "bubble boy" disease — a severe immune disorder called SCID-X1. They used a different style of gene therapy: a virus that delivered a working copy of the broken gene and integrated its DNA into the patient's genome.

The trial cured nine children. Four of them developed T-cell leukemia within five years. The viral DNA had inserted near a gene called LMO2 and switched it on. [13]

The field watched four children get leukemia. This was the fear that had to be answered before any gene-editing drug could be trusted in healthy adults.

This was the problem that Verve Therapeutics needed to fix if they were going to safely and permanently switch off PCSK9.

Enter David Liu. [14]

In the early 2010s, while everyone else was celebrating CRISPR-Cas9 as a revolution, Liu was already worried. "I quickly realized that most of the genetic diseases one might want to treat with genome editing could not be treated only by cutting DNA," he said, "because cutting DNA disrupts the gene." [15]

He pioneered a different approach: base editing.

Base editing finds the target like CRISPR does. But instead of cutting both strands, it nicks one strand gently and chemically swaps a single DNA letter in place — like an A for a G. There's no double-strand break. No imperfect repairs. Just a single letter changed.

This is the technique Verve used in their VERVE-102 drug to switch off PCSK9. The single letter VERVE-102 swaps sits at a splice site — the spot in the gene where the cell reads it. The swap disrupts the read. The gene is silenced and the protein doesn't get made. [16]

Because a base editor doesn't insert a viral vector, doesn't cut both strands, and doesn't integrate any DNA anywhere — the entire category of cancer risk that haunted the SCID-X1 children doesn't apply. The editor arrives as messenger RNA, makes one single-letter change, then breaks down and disappears within days.

This is all reassuring. But the honest caveat is that gene editing is still a young field, and it still surprises us. In October 2025, an 80-year-old patient in Intellia's MAGNITUDE program — a different gene-editing trial for a different disease — had a grade 4 liver injury, was hospitalised, and died a few weeks later. The treating physician described it as a case complicated by other illnesses, and it's still being evaluated, but the FDA placed that trial on a clinical hold. [17] [18]

The uncertainty in the field is why every base-editing patient is enrolled in fifteen years of mandatory follow-up. [16]

But along with the risks are the wins. Alyssa Tapley is a teenager in the UK. In 2022, she had T-cell leukemia that wasn't responding to standard treatment. She became the first person ever treated with a base editor — the same technology family used in VERVE-102. A month after the treatment, she was in remission. In April 2025, when David Liu received the Breakthrough Prize for inventing base editing, Alyssa stood on stage with him. [19] [20]

## The Delivery Truck

The base-editing machinery is large, fragile, and easy for the immune system to destroy. To make it useful, you need a vehicle that protects it, gets it to the right tissue, and disappears once the job is done.

The vehicle that solved this is the lipid nanoparticle.

And there's a quirk of biology that made the liver the natural first target. Inject a lipid nanoparticle into the bloodstream, and within minutes, the liver pulls it out of circulation. The liver is, biologically, the path of least resistance for this kind of cargo.

The technology was compelling. But would it work to target PCSK9 in the liver? The first step Verve took was to try it in animals.

That paper came out in Nature in 2021. Verve gave monkeys a single dose of a PCSK9 base editor packaged in a lipid nanoparticle. PCSK9 production fell by about 90%. LDL cholesterol dropped by about 60%. And the effects persisted at 8 months after that single dose. [21]

That's the proof-of-concept that put Verve on the map.

But monkeys aren't humans. And the first human trial nearly ended the program.

## The Setback and the Result

By April 2024, Verve had been dosing patients in ascending-dose groups in a trial called Heart-1. In the cohort receiving 0.45 milligrams per kilogram, the first five were fine. The sixth was the one I mentioned at the start.

Within four days of the infusion, their platelet count crashed and their ALT — a liver enzyme — spiked. Both at grade 3 severity. The patient stayed asymptomatic — no bleeding, no symptoms — and the abnormalities resolved fully within a few days. [1]

Researchers needed to understand what happened. Was the problem the editor — the actual machinery that swapped a single letter of DNA? Or was it the delivery — the truck that carried the editor to the liver?

The answer turned out to be the truck.

So Verve discontinued the original treatment form — VERVE-101.

They designed a new truck. They swapped out one of the lipids for a different formulation. And they added a small sugar tag on the outside of the nanoparticle, called GalNAc. GalNAc is recognised by a receptor that's almost only found on liver cells — so the new nanoparticle is pulled into liver cells within minutes, and most of the rest of the body just ignores it. [16]

They renamed the drug VERVE-102. They restarted the trial in the spring of 2024.

It included 35 patients across six dose cohorts. All thirty-five had either a genetic condition that causes high LDL cholesterol levels, or premature coronary artery disease, or both. [16]

They were already on a maximum-tolerated statin. Just under half were also on ezetimibe. These were people who had already done the standard cholesterol-lowering work and were still carrying a baseline LDL that was too high. [16]

The dose cohorts started at 0.3 milligrams per kilogram and climbed in six steps to 1.0 milligrams per kilogram. At the top dose, PCSK9 dropped by 88%. LDL cholesterol dropped by 62%. Mean levels went from 128 milligrams per decilitre down to 51. The effect held across the follow-up window — up to 18 months in the longest-followed patients, with fifteen of the thirty-five now past a full year. [16]

The impact here is hard to overstate. A 62% drop in LDL cholesterol — on top of a maximum-tolerated statin. From one infusion. One. And so far, safety looks promising. There have been no deaths, no dose-limiting toxicities, no withdrawals. Three patients had a small increase in liver enzymes that peaked on day 3 or 4 and resolved by day 8. There was one serious adverse event (aspiration pneumonitis), but it was judged unrelated by the site investigator. And the platelet crash that ended VERVE-101 didn't show up at all. [16]

As the authors put it: "A reduction of this magnitude, if maintained over 20 years, is predicted to reduce the risk of atherosclerotic cardiovascular disease by more than 50% for most patients with hypercholesterolemia." [16]

But the "if" is important. These are early results, with a relatively short follow up. We'll need larger and longer studies before we're ready to declare an end to heart disease.

## What's Next

Another study is in the works. Lilly, which bought Verve Therapeutics, plans to begin a larger trial later this year to continue to evaluate the effectiveness of VERVE-102. [22]

While we wait for the results, what can we do right now to meaningfully lower LDL cholesterol? Diet and exercise are, of course, the foundation. But for many, they aren't enough.

The standard tools — statins and ezetimibe — have decades of evidence behind them, and they're cheap and well-tolerated. If your LDL cholesterol is high, that's the conversation to have with your doctor today.

## References

1. https://www.cgtlive.com/view/verve-moves-on-second-gen-cardiovascular-crispr-therapy-verve-102-adverse-events
2. https://www.framinghamheartstudy.org/fhs-about/
3. https://pubmed.ncbi.nlm.nih.gov/15172426/
4. https://academic.oup.com/eurheartj/article/38/32/2459/3745109
5. https://www.nejm.org/doi/full/10.1056/NEJMoa054013
6. https://bpspubs.onlinelibrary.wiley.com/doi/10.1111/bcp.14811
7. https://pmc.ncbi.nlm.nih.gov/articles/PMC9377665/
8. https://embryo.asu.edu/pages/crispr-acquired-resistance-against-viruses-2007
9. https://www.science.org/doi/10.1126/science.1138140
10. https://www.science.org/doi/10.1126/science.1225829
11. https://pmc.ncbi.nlm.nih.gov/articles/PMC7782372/
12. https://pmc.ncbi.nlm.nih.gov/articles/PMC6390938/
13. https://www.jci.org/articles/view/35700
14. https://www.broadinstitute.org/bios/david-liu
15. https://www.harvardmagazine.com/science/david-liu-harvard-gene-editing-research-disease-cures
16. https://www.nejm.org/doi/full/10.1056/NEJMoa2601283
17. https://ir.intelliatx.com/news-releases/news-release-details/intellia-therapeutics-provides-update-magnitude-clinical-trials
18. https://www.cgtlive.com/view/patient-treated-trial-intellia-transthyretin-amyloidosis-gene-editing-therapy-nex-z-dies
19. https://news.harvard.edu/gazette/story/2025/04/rewriting-genetic-destiny-gene-base-editing/
20. https://www.nejm.org/doi/full/10.1056/NEJMoa2505478
21. https://www.nature.com/articles/s41586-021-03534-y
22. https://investor.lilly.com/news-releases/news-release-details/single-dose-lillys-pcsk9-base-editor-verve-102-reduced-pcsk9-88
