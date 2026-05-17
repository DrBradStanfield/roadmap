---
title: "What's Causing Colon Cancer to Rise So Fast?"
url: "https://drstanfield.com/blogs/articles/whats-causing-colon-cancer-to-rise-so-fast"
youtube: "https://www.youtube.com/watch?v=cFF5KV5hFsU"
publishedAt: "2026-05-17T17:05:00Z"
tags: ["Research", "Preventative Care", "Diet"]
keywords: ["bmi", "colon cancer", "colonoscopy", "exercise", "fiber", "gut health", "microbiome", "obesity", "weight loss"]
summary: "Dr Brad's early-onset colon cancer post: three research teams point at different suspects — picloram herbicide (OR 1.77), childhood E. coli colibactin (21% of CRC), and ultra-processed food (45% higher adenoma risk). Covers FIT screening from 45, fibre, activity, symptoms not to ignore."
---

Colon cancer rates in people under 50 have roughly doubled in twenty years. Nobody knows why. The incidence in the sigmoid colon nearly doubled from 1998 to 2022 in people aged 20–49, and 22% of all colorectal cancers are now diagnosed in people under 55 — twice the 11% figure from 1995, even as that age group has been shrinking [1].

But right now, three different research teams — on three different continents — are each chasing a different suspect. One team in Barcelona thinks it's a 1964 herbicide. One team in San Diego thinks it's a bacteria most of us picked up as toddlers. And one team in Boston thinks it's the food on your plate.

So who's right? I'll explain what each team actually found. The headlines tend to latch onto one suspect as *the* cause for the rise in early-onset colorectal cancer. The actual story is more interesting than that.

## Barcelona — The Herbicide Theory

In a research building on the edge of Barcelona — the Vall d'Hebron Institute of Oncology — a postdoc named Silvana Maas was working on a question a colleague, José Seoane, had been turning over for years. Why are we seeing colon cancer in people in their thirties and forties?

The Maas–Seoane lab doesn't ask that question with a food diary or a survey. They ask it by reading the tumour itself.

Here's how Seoane describes the method [2]: "If we imagine the genome as a book, epigenetic marks don't change the text but function like post-its or markers that indicate which chapters should be read and which should be skipped."

So your DNA is the text — fixed at birth. But on top of that text, your cells stick little chemical post-it notes that tell the cell which chapters to read and which to skip. Those post-it notes are called methylation marks. They can turn genes on or off — including genes that control how cells grow and divide. And here's the key thing — environmental exposures over a person's life seem to leave their own fingerprints on which post-its end up where.

So the team had an idea. What if you could go into a colon cancer tumour, read the post-it pattern, and use it to *infer* what that person had been exposed to over their life?

They pulled 31 colon cancers from people under 50. They pulled 100 colon cancers from people over 70. Both sets came from a public US tumour database called TCGA. And they built methylation-based scores for 14 different pesticides — proxies for exposure, not measurements of it — and tested which proxy lined up most with the young patients [3].

One pesticide kept rising to the top. A herbicide called picloram, originally developed by Dow Chemical, used on rangeland and roadsides and utility corridors all across the United States since 1964.

In that first analysis — what scientists call the discovery cohort — the odds ratio was striking: 3.06 [95% CI 1.88–5.36] [3].

A three-fold odds ratio. That's the number quoted on a popular podcast last week — the All-In Podcast covered this paper, and that 3x is the figure they cited.

But the team didn't stop there. They did what good science demands. They tested their results. They went out and pulled nine more independent colon cancer cohorts — completely separate datasets, 83 young-onset cases and 272 older cases — and ran the same analysis again. Same methylation method, new patients.

The signal held. But it shrank to an odds ratio of 1.56 [1.16–2.09]. The combined estimate across both discovery and replication landed at 1.77 [1.29–2.43] [3].

That's the rhythm of good replication. The first dataset is small, so the signal can look bigger than it is. The second dataset is wider, the signal shrinks, and the second number is the more reliable one. And the team led with that smaller number themselves.

So is the picloram link real? The evidence is, at the least, suggestive. Is it three times the risk? Almost certainly not. The honest answer from this paper alone is closer to one and a half times — and even that comes with two real caveats. The team never measured anybody's actual picloram exposure. They built a methylation-based proxy and admitted in their own paper that they couldn't validate that proxy against direct exposure data, because that direct data doesn't exist [3].

Some critics looking at this paper aren't convinced the proxy holds up at all. They point out that using such an indirect measure of exposure introduces multiple possible sources of uncertainty in the data. And then an analyst pulled the German data — and the picture got more complicated [4].

Germany is one of the few countries that publishes annual herbicide sales going back decades. Their picloram series is unusual. Three small entries in the late 1980s. Then sixteen consecutive years of zero domestic sales, from 1990 through 2005. Then a slow return to the market.

So Germans in their thirties and forties today largely grew up while picloram was effectively absent from their domestic market. EU residue monitoring across 2,386 samples from 2013 to 2023 consistently came back below detection limits [5].

And yet German rates of early-onset colon cancer have risen at almost the same pace as in the US over the same period — an annual increase of 1.16% in men and 1.32% in women in Germany [6], compared with the US going from 8.6 per 100,000 in 1992 to 12.9 per 100,000 in 2018 [7].

That doesn't kill the picloram theory. Two trends going up at the same time can have distinct causes, and the team's molecular signal in tumour tissue is real. But it does mean a herbicide that one country sold zero tonnes of for sixteen years can't be the whole story for a rise that hit both countries together.

So the Barcelona team has an interesting lead, a real signal in the methylation data, and a critique that will require further data to answer.

But while Barcelona was reading methylation marks, in California a young computational biologist couldn't stop staring at a pattern in his data — a pattern he wasn't even looking for. And what he found has a much more direct mechanism behind it.

## San Diego — The Childhood Bacteria Theory

Marcos Díaz-Gay is a young computational biologist who, until recently, was working in Ludmil Alexandrov's lab at the University of California, San Diego. The Alexandrov lab has a specialty — they read mutational signatures. The specific patterns of typos in cancer DNA that tell you what damaged the DNA in the first place. UV light leaves one signature. Tobacco smoke leaves a different one. Each carcinogen has its fingerprint.

In April 2025, Díaz-Gay and Alexandrov published one of the largest mutational-signature studies ever done in colon cancer — 981 colon cancer genomes from 11 different countries [8].

Now here's the thing. They weren't trying to solve the early-onset puzzle. As Díaz-Gay described it [9]: "When we started this project, we weren't planning to focus on early-onset colorectal cancer. Our original goal was to examine global patterns. But as we dug into the data, one of the most interesting and striking findings was how frequently colibactin-related mutations appeared in the early-onset cases."

That's a researcher discovering something they weren't looking for. Which is often when the most interesting findings happen. Colibactin is a toxin. Not a chemical you eat. Not a herbicide on a farm. A toxin produced by certain strains of E. coli — bacteria that live in the gut. Specifically, the strains tagged "pks-positive." If those bacteria colonise your colon, they produce colibactin, and colibactin physically damages the DNA of the cells lining your intestine. It leaves a specific fingerprint — two of them, actually.

And here's what Díaz-Gay's team found in those 981 tumours. The two fingerprints of colibactin were 2.5 and 4 times more common in early-onset colorectal cancers compared to those that developed later in life. About 21% of colorectal cancers overall had the colibactin-associated mutations [8].

But this is the part that genuinely got my attention. Work from the Wellcome Sanger Institute has shown that colibactin-associated mutations arise early in tumour evolution and are thought to reflect exposure occurring in early life, possibly within the first decade [10]. Díaz-Gay's team found those same colibactin-driven typos sitting in the earliest mutations behind these tumours. The bacteria do their damage in childhood. The cancer shows up forty years later.

Alexandrov puts it in stark terms [11]: "If someone acquires one of these driver mutations by the time they're 10 years old, they could be decades ahead of schedule for developing colorectal cancer, getting it at age 40 instead of 60."

That is biologically very different from picloram. With picloram, you have a methylation correlation and inferred exposure. With colibactin, you have a known bacterial toxin, a known mechanism — it directly binds DNA and creates double-strand breaks — and a specific molecular fingerprint you can read in the tumour decades after the damage was done.

The Barcelona team has a correlation. The San Diego team has a mechanism.

So is colibactin the answer? It might be a big piece of it. The study found 21% of all colon cancers carry this signature, which is not a small number. But there's a problem this theory doesn't solve. If the damage was done in childhood, what are you supposed to do about it as a 45-year-old? You can't go back and change the bacteria you carried at age six.

Which is why a third team — this one in Boston — built their entire study around a question Barcelona and San Diego couldn't answer. What if we stopped reading the tumour, and started watching the disease arrive?

## Boston — The Ultra-Processed Food Theory

Andrew Chan is a gastroenterologist at Massachusetts General Hospital. Yin Cao is a cancer epidemiologist at Washington University in St. Louis. Together they co-lead an international consortium called PROSPECT — a $25-million Cancer Grand Challenges initiative built specifically to find out why early-onset colorectal cancer is rising. Same Cancer Grand Challenges, incidentally, that funded the Mutographs team in San Diego whose colibactin paper we just looked at.

Chan and Cao had a different idea. Instead of reading the typos in a tumour after the cancer had already happened, they wanted to be there before it did. Thousands of healthy women, decades of food diaries, serial colonoscopies — and then sit and wait. That's the Nurses' Health Study II — a prospective cohort of 29,105 women, followed from 1991 to 2015, with their food intake recorded before anyone got sick [12].

This is methodologically different from the other two. The Barcelona and San Diego teams looked backwards — they took tumours and tried to figure out what caused them. The Boston team looked forwards. They asked thousands of healthy women what they were eating. Then they waited. Then they did colonoscopies. Then they counted who developed early adenomas — the precursor lesions that turn into colon cancer.

What Cao and Chan's team was looking for was ultra-processed food. Not "junk food" loosely defined. Specifically: foods that have been industrially formulated using ingredients you wouldn't have in your kitchen — emulsifiers, stabilisers, modified starches, packaged snacks, soft drinks, processed meats, instant meals.

Here's what they found. Ten servings of ultra-processed food a day versus three. A 45% higher risk of the lesions most likely to become colon cancer (adjusted OR 1.45; 95% CI 1.19–1.77; *P* < .001). No association was seen for serrated lesions [12].

Now — this is still an association. Ultra-processed food is a basket, not a single chemical. The 45% increase could be coming from emulsifiers disrupting the gut barrier. It could be coming from low fibre. It could be coming from a confounding pattern of life — people who eat ten servings of ultra-processed food a day tend to weigh more and exercise less. The Boston team adjusted for many of those things — including body mass index, type 2 diabetes, fibre, folate, calcium, vitamin D and overall diet quality — but not all of them, and there isn't a single "this is the molecule" story like there is with colibactin.

And the team itself doesn't claim this is the answer. As Chan put it [13]: "Diet isn't a complete explanation for why we're seeing this trend — we see many individuals in our clinic with early-onset colon cancer who eat very healthy diets."

But this study has something the Barcelona and San Diego studies don't. It measured exposure directly, in real people, before they got sick. That's the strongest study design in observational epidemiology — and on this question, the Boston team has the cleanest version of it.

So here's where we are. The Barcelona team has a chemical with a methylation fingerprint and an odds ratio of about 1.77 — alongside a German data problem the team can't yet explain. The San Diego team has a bacterial toxin with a direct DNA-damaging mechanism, present in 21% of all colon cancers, with damage done in childhood. The Boston team has a 45% higher adenoma rate at the high end of ultra-processed food intake, in a 29,000-woman prospective cohort — and the senior author saying it isn't the whole answer.

Three teams. Three suspects. Each one makes the others look incomplete.

## The Verdict

This is the part of science the headlines don't show.

When a paper drops, the news cycle wants one suspect. Researchers find the cause of young colon cancer. Clean headline. Almost always wrong.

What's actually happening is what we just saw. Three serious teams, three continents, three different lenses — and each one finding real evidence for a different suspect. I'm not going to pick a winner. The more interesting thing is that all three teams are doing what good science requires: they're trying to disprove their own theories. Maas and Seoane reported the smaller replication number alongside their headline one. Díaz-Gay published a finding he wasn't even looking for. Chan told the press his own diet result doesn't explain everything.

That's how this gets solved. Not one paper, one podcast, one headline. Teams on different continents holding their theories up against the data and willing to be wrong.

So if you're 35 years old, reading this article, what do you actually do tomorrow morning while these three labs keep at it?

## What You Can Actually Do

The boring answer happens to be the right answer. The interventions we already know work for colon cancer don't depend on which of these three teams turns out to be most right. They cover all three.

If you're 45 and you haven't had a colon cancer screening test, that's the single highest-impact thing on this list. A stool-based test called a FIT test is a great starting point. The USPSTF dropped the start age from 50 to 45 specifically because of this rise in early-onset disease [14]. I advise my patients not to wait until 50, and not to wait for symptoms.

Personally, I plan to take it a step further and do my first stool FIT test when I turn 35 this year.

Next is fibre. This suggestion may need tweaking for people with irritable bowel syndrome or inflammatory bowel disease. But a high-fibre diet — fruits, vegetables, whole grains, legumes — is one of the most consistently associated dietary factors with lower colon cancer risk. Most adults under-eat it. In one nested case-control study using food diaries, the highest quintile of fibre intake density was associated with a 34% lower odds of colorectal cancer compared with the lowest [15].

Body weight and activity. Obesity and sedentary behaviour both push colon cancer risk up — a meta-analysis of 66 studies puts the elevation at 25–57% [16]. Activity pushes it down. Walking, cycling, anything regular — the evidence is consistent [17].

Ultra-processed food. Whatever the Boston team's exact number turns out to be, the directional advice is uncontested across multiple cohorts — an earlier BMJ analysis of three large US prospective cohorts found higher ultra-processed food intake was linked to higher colorectal cancer risk in men and certain subgroups of women [18]. Push your diet toward whole foods. Push it away from packaged.

Symptoms. Don't ignore them. Blood in the stool. Persistent change in bowel habits. Unexplained weight loss. Persistent abdominal pain. Rectal bleeding in patients over 50 has a pooled positive predictive value for colorectal cancer of around 8%, and the risk climbs further when it's combined with weight loss or a change in bowel habit [19].

If you're under 50 and you've had any of these symptoms for more than a couple of weeks, ask your doctor specifically about colorectal cancer. Don't accept "you're too young to worry about it" — that's exactly the thinking the data has now overturned.

All of this is part of being proactive so we avoid problems and catch them early. It's the same logic that's formed the basis of how we approach heart attack prevention for years.

## References

1. https://doi.org/10.3322/caac.70067
2. https://www.eurekalert.org/news-releases/1125132
3. https://www.nature.com/articles/s41591-026-04342-5
4. https://www.chaotropy.com/a-nature-medicine-paper-linking-picloram-to-early-onset-colorectal-cancer-leaves-an-open-question/
5. https://doi.org/10.2903/j.efsa.2024.9067
6. https://pubmed.ncbi.nlm.nih.gov/36471648/
7. https://pmc.ncbi.nlm.nih.gov/articles/PMC9177054/
8. https://www.nature.com/articles/s41586-025-09025-8
9. https://www.medicaldaily.com/colorectal-cancers-young-adults-childhood-exposure-common-gut-bacteria-blame-473443
10. https://www.medcentral.com/gastroenterology/bacterial-toxins-linked-to-early-onset-colorectal-cancer
11. https://news.cancerresearchuk.org/2025/04/23/colibactin-e-coli-early-onset-bowel-cancer/
12. https://jamanetwork.com/journals/jamaoncology/article-abstract/2841354
13. https://www.massgeneralbrigham.org/en/about/newsroom/press-releases/ultra-processed-foods-early-onset-colorectal-cancer-study
14. https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening
15. https://pubmed.ncbi.nlm.nih.gov/20407088/
16. https://pmc.ncbi.nlm.nih.gov/articles/PMC12181496/
17. https://pmc.ncbi.nlm.nih.gov/articles/PMC10441558/
18. https://www.bmj.com/content/378/bmj-2021-068921
19. https://pmc.ncbi.nlm.nih.gov/articles/PMC3080228/
