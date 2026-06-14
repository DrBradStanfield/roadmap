/**
 * Evidence data for health suggestions.
 *
 * Maps suggestion IDs to:
 * - reason: Patient-facing explanation of WHY this recommendation is made
 * - guidelines: Short labels for always-visible guideline tags
 * - references: Clickable study/guideline links (DOI or stable URLs)
 *
 * SCREENING VARIANTS: Suggestions with dynamic suffixes (-overdue, -upcoming, -followup)
 * share evidence with their base ID. The attachment code in suggestions.ts handles
 * prefix matching for these.
 *
 * DOI STATUS:
 * - All DOIs verified via web lookup against roadmap_text.html citations
 */

export interface SuggestionReference {
  label: string;
  url: string;
}

export interface SuggestionEvidence {
  reason: string;
  guidelines: string[];
  references: SuggestionReference[];
}

// ============================================================
// Shared reference blocks (reused across related suggestions)
// ============================================================

const REFS_PROTEIN: SuggestionReference[] = [
  { label: 'Naghshi 2020 – Protein & all-cause mortality (BMJ meta-analysis)', url: 'https://doi.org/10.1136/bmj.m2412' },
  { label: 'Morton 2018 – Protein & muscle gains (Br J Sports Med meta-analysis)', url: 'https://doi.org/10.1136/bjsports-2017-097608' },
  { label: 'Jäger 2017 – ISSN position stand: protein & exercise', url: 'https://doi.org/10.1186/s12970-017-0177-8' },
  { label: 'Tagawa 2021 – Protein dose-response for muscle mass (Nutr Rev)', url: 'https://doi.org/10.1093/nutrit/nuaa104' },
];

const REFS_SODIUM: SuggestionReference[] = [
  { label: 'Filippini 2021 – Sodium reduction & blood pressure (Circulation)', url: 'https://doi.org/10.1161/CIRCULATIONAHA.120.050371' },
  { label: 'Huang 2020 – Dietary sodium reduction & BP (BMJ)', url: 'https://doi.org/10.1136/bmj.m315' },
];

const REFS_BP_LIFESTYLE: SuggestionReference[] = [
  { label: 'Charchar 2023 – ISH lifestyle management of hypertension', url: 'https://doi.org/10.1097/HJH.0000000000003563' },
];

const REFS_EXERCISE: SuggestionReference[] = [
  { label: 'Piercy 2018 – Physical Activity Guidelines for Americans (JAMA)', url: 'https://doi.org/10.1001/jama.2018.14854' },
  { label: 'Lear 2017 – Physical activity & mortality in 130,000 people (Lancet PURE)', url: 'https://doi.org/10.1016/S0140-6736(17)31634-3' },
  { label: 'Kodama 2009 – Cardiorespiratory fitness & mortality (JAMA)', url: 'https://doi.org/10.1001/jama.2009.681' },
];

const REFS_LIPID_GUIDELINES: SuggestionReference[] = [
  { label: '2026 ACC/AHA Dyslipidemia Guideline (JACC)', url: 'https://doi.org/10.1016/j.jacc.2025.11.016' },
  { label: 'Mach 2020 – ESC/EAS Dyslipidaemia Guidelines (Eur Heart J)', url: 'https://doi.org/10.1093/eurheartj/ehz455' },
];

const REFS_LIPID_EVIDENCE: SuggestionReference[] = [
  ...REFS_LIPID_GUIDELINES,
  { label: 'Borén 2020 – LDL causes atherosclerosis: EAS consensus (Eur Heart J)', url: 'https://doi.org/10.1093/eurheartj/ehz962' },
  { label: 'Sniderman 2019 – ApoB & cardiovascular disease (JAMA Cardiol)', url: 'https://doi.org/10.1001/jamacardio.2019.3780' },
];

const REFS_PESA: SuggestionReference[] = [
  { label: 'Ibanez 2021 – PESA study: subclinical atherosclerosis progression (JACC)', url: 'https://doi.org/10.1016/j.jacc.2021.05.011' },
];

const REFS_LDL_SAFETY: SuggestionReference[] = [
  { label: 'Karagiannis 2021 – Safety of very low LDL (<30 mg/dL) (Eur Heart J)', url: 'https://doi.org/10.1093/eurheartj/ehaa1080' },
  { label: 'Patti 2023 – Very low LDL intensive lowering: safety & efficacy', url: 'https://doi.org/10.1093/ehjcvp/pvac049' },
  { label: 'Navarese 2018 – LDL lowering & cardiovascular mortality (JAMA)', url: 'https://doi.org/10.1001/jama.2018.2525' },
];

const REFS_LPA: SuggestionReference[] = [
  { label: '2026 ACC/AHA Dyslipidemia Guideline (JACC)', url: 'https://doi.org/10.1016/j.jacc.2025.11.016' },
  { label: 'Kronenberg 2022 – Lp(a) in cardiovascular disease: EAS consensus (Eur Heart J)', url: 'https://doi.org/10.1093/eurheartj/ehac361' },
];

const REFS_GLP1: SuggestionReference[] = [
  { label: 'Wilding 2021 – Semaglutide for overweight/obesity: STEP 1 trial (NEJM)', url: 'https://doi.org/10.1056/NEJMoa2032183' },
  { label: 'Wilding 2022 – Weight regain after semaglutide withdrawal (Diabetes Obes Metab)', url: 'https://doi.org/10.1111/dom.14725' },
];

const REFS_SGLT2I: SuggestionReference[] = [
  { label: 'Zinman 2015 – EMPA-REG OUTCOME: empagliflozin CV outcomes (NEJM)', url: 'https://doi.org/10.1056/NEJMoa1504720' },
  { label: 'McMurray 2019 – DAPA-HF: dapagliflozin in heart failure (NEJM)', url: 'https://doi.org/10.1056/NEJMoa1911303' },
];

const REFS_BP_TRIALS: SuggestionReference[] = [
  { label: 'SPRINT 2015 – Intensive BP lowering <120 mmHg (NEJM)', url: 'https://doi.org/10.1056/NEJMoa1511939' },
  { label: 'Liu 2024 – ESPRIT: intensive BP lowering incl. diabetes (Lancet)', url: 'https://doi.org/10.1016/S0140-6736(24)01028-6' },
];

const REFS_SCREENING_ACS: SuggestionReference[] = [
  { label: 'American Cancer Society – Screening Guidelines', url: 'https://www.cancer.org/cancer/screening/american-cancer-society-guidelines-for-the-early-detection-of-cancer.html' },
];

const GUIDELINES_LIPIDS = ['ACC/AHA 2026', 'ESC/EAS 2019'];
const GUIDELINES_BP = ['ISH/ESH 2023'];

// ============================================================
// Evidence map
// ============================================================

export const SUGGESTION_EVIDENCE: Record<string, SuggestionEvidence> = {

  // ── Nutrition ──────────────────────────────────────────────

  'protein-target': {
    reason: 'Higher protein intake supports muscle maintenance, metabolic health, and healthy aging. Research shows that 1.2g per kg of ideal body weight optimises muscle protein synthesis. If kidney function is reduced (eGFR below 45), a lower target of 1.0g/kg is recommended to reduce kidney workload.',
    guidelines: ['ISSN 2017'],
    references: REFS_PROTEIN,
  },

  'low-salt': {
    reason: 'Excess sodium raises blood pressure by increasing fluid retention. The ACC/AHA guidelines recommend an ideal sodium intake of less than 1,500mg per day for most adults. Meta-analyses confirm that reducing sodium intake produces meaningful blood pressure reductions, with greater benefit in those who already have elevated blood pressure.',
    guidelines: [...GUIDELINES_BP, 'ACC/AHA 2017'],
    references: [
      ...REFS_SODIUM,
      ...REFS_BP_LIFESTYLE,
      { label: 'Whelton 2017 – ACC/AHA Blood Pressure Guideline (Hypertension)', url: 'https://doi.org/10.1161/HYP.0000000000000065' },
    ],
  },

  'fiber': {
    reason: 'Dietary fibre lowers cardiovascular risk through multiple mechanisms: reducing cholesterol absorption, improving blood sugar control, and supporting a healthy gut microbiome. A Cochrane review found that higher fibre intake significantly reduces cardiovascular events.',
    guidelines: [],
    references: [
      { label: 'Hartley 2016 – Dietary fibre & cardiovascular disease (Cochrane Review)', url: 'https://doi.org/10.1002/14651858.CD011472.pub2' },
    ],
  },

  'high-potassium': {
    reason: 'Potassium helps counteract the blood-pressure-raising effects of sodium. The ISH recommends 3,500–5,000mg/day from food sources. This recommendation only applies when kidney function is adequate (eGFR ≥45), as impaired kidneys may not excrete excess potassium safely.',
    guidelines: [...GUIDELINES_BP],
    references: REFS_BP_LIFESTYLE,
  },

  'lipid-diet': {
    reason: 'These foods lower LDL cholesterol through complementary mechanisms: beta-glucan (oats) and soluble fibre (psyllium, flaxseed) bind bile acids, reducing cholesterol reabsorption. Nuts (walnuts, almonds) provide unsaturated fats that improve the LDL-to-HDL ratio. Replacing saturated fat (butter) with monounsaturated fat (extra-virgin olive oil) directly lowers LDL. Soy protein (edamame) modestly reduces LDL when replacing animal protein. Combined, these dietary changes can reduce LDL cholesterol by 15–25%.',
    guidelines: ['ACC/AHA 2026 Dyslipidemia'],
    references: [
      { label: 'Jenkins 2011 – Portfolio Diet effect on LDL cholesterol (JAMA)', url: 'https://doi.org/10.1001/jama.2011.1202' },
      { label: 'Sabaté 2010 – Nut consumption and blood lipid levels (Arch Intern Med)', url: 'https://doi.org/10.1001/archinternmed.2010.79' },
      { label: 'Wei 2009 – Psyllium fibre lowers cholesterol: meta-analysis (Eur J Clin Nutr)', url: 'https://doi.org/10.1038/ejcn.2008.49' },
    ],
  },

  'trig-nutrition': {
    reason: 'Blood triglycerides are highly responsive to dietary changes — improvements can be seen within 2–3 weeks. The most effective dietary measures are reducing alcohol, sugar, and total calorie intake. Mendelian randomisation studies confirm that triglyceride-lowering reduces coronary heart disease risk.',
    guidelines: [],
    references: [
      { label: 'Ference 2019 – Triglyceride-lowering & coronary risk: Mendelian randomisation (JAMA)', url: 'https://doi.org/10.1001/jama.2018.20045' },
    ],
  },

  'reduce-alcohol': {
    reason: 'Alcohol contributes to weight gain (7 calories per gram), raises triglycerides, and elevates blood pressure. The International Society of Hypertension recommends reducing or eliminating alcohol intake for blood pressure management and metabolic health.',
    guidelines: [...GUIDELINES_BP],
    references: REFS_BP_LIFESTYLE,
  },

  // ── Exercise ───────────────────────────────────────────────

  'exercise': {
    reason: 'The Physical Activity Guidelines for Americans recommend at least 150 minutes of moderate-intensity aerobic activity plus 2–3 resistance training sessions per week. Large studies (PURE, 130,000 people across 17 countries) show that higher physical activity reduces all-cause mortality regardless of income level or country. Cardiorespiratory fitness is one of the strongest predictors of longevity.',
    guidelines: ['Physical Activity Guidelines 2018'],
    references: REFS_EXERCISE,
  },

  // ── Sleep ──────────────────────────────────────────────────

  'sleep': {
    reason: 'Consistent sleep of 7–9 hours per night is essential for cardiovascular health, immune function, and cognitive performance. A large meta-analysis of over 1.3 million participants found that both short sleep (<6 hours) and long sleep (>8–9 hours) are associated with significantly increased mortality risk.',
    guidelines: [],
    references: [
      { label: 'Cappuccio 2010 – Sleep duration & all-cause mortality: meta-analysis (Sleep)', url: 'https://doi.org/10.1093/sleep/33.5.585' },
    ],
  },

  // ── Weight & Diabetes Medications ──────────────────────────

  'weight-med-glp1': {
    reason: 'GLP-1 receptor agonists like tirzepatide and semaglutide have been shown in large randomised trials to produce significant, sustained weight loss alongside improvements in blood sugar, blood pressure, and triglycerides. Tirzepatide is preferred due to its dual GIP/GLP-1 mechanism, which may provide greater weight loss. These medications work best alongside diet, exercise, and sleep optimisation.',
    guidelines: [],
    references: REFS_GLP1,
  },

  'weight-med-glp1-increase': {
    reason: 'GLP-1 medications show a dose-dependent response — higher doses generally produce greater weight loss and metabolic improvement. Clinical trials used a gradual dose-escalation approach to improve tolerability.',
    guidelines: [],
    references: REFS_GLP1,
  },

  'weight-med-glp1-switch': {
    reason: 'Tirzepatide (Mounjaro/Zepbound) works on both GIP and GLP-1 receptors, which may provide greater weight loss than GLP-1-only medications. In clinical trials, tirzepatide achieved up to 22% body weight loss.',
    guidelines: [],
    references: REFS_GLP1,
  },

  'weight-med-sglt2i': {
    reason: 'SGLT2 inhibitors (empagliflozin, dapagliflozin) work by a different mechanism to GLP-1 medications — they cause the kidneys to excrete excess glucose. Beyond modest weight loss, they provide proven cardiovascular and kidney protection, making them a valuable addition for metabolic health.',
    guidelines: [],
    references: REFS_SGLT2I,
  },

  'weight-med-metformin': {
    reason: 'Metformin has been used for decades to improve blood sugar control. The Diabetes Prevention Program (DPP) study showed that metformin reduced diabetes progression. Extended-release formulations cause fewer gastrointestinal side effects.',
    guidelines: [],
    references: [
      { label: 'Lee 2021 – Metformin & mortality in Diabetes Prevention Program (Diabetes Care)', url: 'https://doi.org/10.2337/dc21-1046' },
    ],
  },

  'weight-glp1': {
    reason: 'GLP-1 receptor agonists like tirzepatide and semaglutide have been shown in large randomised trials to produce significant weight loss alongside improvements in metabolic health. These medications work best as part of a comprehensive approach including diet, exercise, and sleep.',
    guidelines: [],
    references: REFS_GLP1,
  },

  // ── General ────────────────────────────────────────────────

  'measure-waist': {
    reason: 'With a BMI in the 25–30 range, waist circumference is critical for determining whether your weight poses health risks. The AACE 2025 guidelines and NICE guidelines use waist-to-height ratio (WHtR) to reclassify individuals — a WHtR below 0.5 indicates healthy body composition even with a BMI of 25–29.9.',
    guidelines: ['AACE 2025', 'NICE'],
    references: [
      { label: 'Ashwell 2012 – WHtR better than BMI for cardiometabolic risk (Obes Rev)', url: 'https://doi.org/10.1111/j.1467-789X.2011.00952.x' },
    ],
  },

  // ── Blood Work: HbA1c ─────────────────────────────────────

  'hba1c-diabetic': {
    reason: 'An HbA1c in the diabetic range (≥6.5% / ≥47.5 mmol/mol) indicates sustained high blood sugar levels over the past 2–3 months. This requires medical management to prevent complications including cardiovascular disease, kidney damage, nerve damage, and vision loss.',
    guidelines: ['ADA Standards of Care'],
    references: [
      { label: 'ADA – Standards of Medical Care in Diabetes', url: 'https://diabetesjournals.org/care/issue/47/Supplement_1' },
    ],
  },

  'hba1c-prediabetic': {
    reason: 'An HbA1c in the prediabetic range (5.7–6.4% / 38.8–47.4 mmol/mol) means your blood sugar is higher than normal but not yet diabetic. This is a critical window — lifestyle changes at this stage can prevent or significantly delay progression to type 2 diabetes.',
    guidelines: ['ADA Standards of Care'],
    references: [
      { label: 'ADA – Standards of Medical Care in Diabetes', url: 'https://diabetesjournals.org/care/issue/47/Supplement_1' },
    ],
  },

  'hba1c-normal': {
    reason: 'A normal HbA1c (below 5.7% / below 38.8 mmol/mol) indicates healthy blood sugar control over the past 2–3 months. Maintaining this through diet, exercise, and healthy weight reduces your long-term risk of diabetes.',
    guidelines: ['ADA Standards of Care'],
    references: [
      { label: 'ADA – Standards of Medical Care in Diabetes', url: 'https://diabetesjournals.org/care/issue/47/Supplement_1' },
    ],
  },

  // ── Blood Work: Atherogenic Lipids ─────────────────────────

  'apob-very-high': {
    reason: 'ApoB directly measures the number of atherogenic (artery-clogging) particles in your blood and is considered the most accurate predictor of cardiovascular risk by the European Atherosclerosis Society. Each LDL, VLDL, and Lp(a) particle carries exactly one ApoB molecule, making it a superior marker to LDL cholesterol, which only estimates particle concentration. A very high ApoB indicates significantly elevated cardiovascular risk, and statin therapy is typically recommended.\n\nDr Stanfield uses on-treatment targets of ≤50 mg/dL (≤0.5 g/L) based on the ESC/EAS guidelines and the PESA study, which demonstrated that subclinical atherosclerosis progression is driven by cumulative LDL/ApoB exposure over time — even in young, apparently healthy adults.',
    guidelines: [...GUIDELINES_LIPIDS, 'EAS Consensus'],
    references: [...REFS_LIPID_EVIDENCE, ...REFS_PESA, ...REFS_LDL_SAFETY],
  },

  'apob-high': {
    reason: 'ApoB directly measures the number of atherogenic (artery-clogging) particles in your blood. It is considered a more accurate predictor of cardiovascular risk than LDL cholesterol by the European Atherosclerosis Society. Your level is elevated and lifestyle modifications and/or medication should be discussed with your doctor.\n\nDr Stanfield uses on-treatment targets of ≤50 mg/dL (≤0.5 g/L) based on ESC/EAS guidelines and the PESA study, which showed that early ApoB/LDL exposure drives atherosclerosis even in young, healthy adults.',
    guidelines: [...GUIDELINES_LIPIDS, 'EAS Consensus'],
    references: [...REFS_LIPID_EVIDENCE, ...REFS_PESA, ...REFS_LDL_SAFETY],
  },

  'apob-borderline': {
    reason: 'ApoB measures the total number of atherogenic particles in your blood. Standard guidelines would classify this level as normal, but Dr Stanfield uses more aggressive targets based on the PESA study, which showed that cumulative LDL/ApoB exposure drives atherosclerosis even in young, apparently healthy adults. This is why your result shows as borderline rather than normal.',
    guidelines: [...GUIDELINES_LIPIDS, 'EAS Consensus'],
    references: [...REFS_LIPID_EVIDENCE, ...REFS_PESA],
  },

  'ldl-very-high': {
    reason: 'Very high LDL cholesterol may indicate familial hypercholesterolaemia, a genetic condition causing elevated LDL from birth. The AHA/ACC and ESC/EAS guidelines recommend statin therapy at this level. A causal relationship between LDL particles and atherosclerosis is well-established through Mendelian randomisation studies and decades of clinical trials.\n\nNote: ApoB is a more accurate marker than LDL cholesterol for cardiovascular risk. If available, ask your doctor about testing ApoB.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: [...REFS_LIPID_EVIDENCE, ...REFS_LDL_SAFETY],
  },

  'ldl-high': {
    reason: 'High LDL cholesterol is a well-established driver of atherosclerosis. The AHA/ACC and ESC/EAS guidelines recommend lifestyle modification and discussion of statin therapy at this level.\n\nNote: ApoB is a more accurate marker than LDL cholesterol for cardiovascular risk. If available, ask your doctor about testing ApoB.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: [...REFS_LIPID_EVIDENCE, ...REFS_LDL_SAFETY],
  },

  'ldl-borderline': {
    reason: 'Standard guidelines would classify this LDL level as normal, but Dr Stanfield uses more aggressive targets based on the PESA study, which showed that cumulative LDL exposure drives atherosclerosis even in young, apparently healthy adults. LDL is a causal factor in atherosclerosis — the lower, the better over a lifetime of exposure.\n\nNote: ApoB is a more accurate marker than LDL cholesterol. If available, ask your doctor about testing ApoB.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: [...REFS_LIPID_EVIDENCE, ...REFS_PESA],
  },

  'non-hdl-very-high': {
    reason: 'Non-HDL cholesterol captures all atherogenic particles (LDL + VLDL + remnants) and is a better predictor of cardiovascular risk than LDL cholesterol alone. Your level is very high, indicating significantly elevated risk. Treatment with statins and lifestyle modification is typically recommended.\n\nNote: ApoB is the most accurate single marker. If available, ask your doctor about testing ApoB.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: REFS_LIPID_EVIDENCE,
  },

  'non-hdl-high': {
    reason: 'Non-HDL cholesterol captures all atherogenic particles (LDL + VLDL + remnants). Your level is high, indicating elevated cardiovascular risk.\n\nNote: ApoB is the most accurate single marker. If available, ask your doctor about testing ApoB.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: REFS_LIPID_EVIDENCE,
  },

  'non-hdl-borderline': {
    reason: 'Non-HDL cholesterol captures all atherogenic particles (LDL + VLDL + remnants). Standard guidelines would classify this level as normal, but Dr Stanfield uses more aggressive targets based on the PESA study, which showed that cumulative exposure to atherogenic lipids drives atherosclerosis even in young, apparently healthy adults.\n\nNote: ApoB is the most accurate single marker. If available, ask your doctor about testing ApoB.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: [...REFS_LIPID_EVIDENCE, ...REFS_PESA],
  },

  // ── Blood Work: Lp(a) ─────────────────────────────────────

  'lpa-elevated': {
    reason: 'Lp(a) is genetically determined — you are born with a set level that cannot be changed through diet or lifestyle. The 2026 ACC/AHA Dyslipidemia Guideline recommends measuring Lp(a) at least once in all adults (Class I). Elevated Lp(a) is an independent cardiovascular risk factor. Since Lp(a) itself cannot be lowered (yet), the strategy is to aggressively reduce all other modifiable risk factors: lipids, blood pressure, blood sugar, weight, and medications where indicated.',
    guidelines: ['ACC/AHA 2026', 'EAS 2022'],
    references: REFS_LPA,
  },

  'lpa-borderline': {
    reason: 'Your Lp(a) is in the borderline range. Lp(a) is genetically determined and does not change with lifestyle. The 2026 ACC/AHA guideline recommends measuring Lp(a) at least once in all adults. Borderline levels still warrant attention to other cardiovascular risk factors.',
    guidelines: ['ACC/AHA 2026', 'EAS 2022'],
    references: REFS_LPA,
  },

  'lpa-normal': {
    reason: 'Your Lp(a) is in the normal range. Since Lp(a) is genetically determined and does not change significantly over time, this is typically a one-time test. The 2026 ACC/AHA guideline recommends measuring Lp(a) at least once in all adults.',
    guidelines: ['ACC/AHA 2026', 'EAS 2022'],
    references: REFS_LPA,
  },

  // ── Blood Work: Other ──────────────────────────────────────

  'total-chol-high': {
    reason: 'Total cholesterol is a broad measure that includes both harmful (LDL, VLDL) and protective (HDL) cholesterol. A high level warrants further investigation with a full lipid panel, ideally including ApoB, to determine which components are elevated.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: REFS_LIPID_GUIDELINES,
  },

  'total-chol-borderline': {
    reason: 'Total cholesterol is a broad measure that includes both harmful and protective cholesterol. A borderline level is worth monitoring. A full lipid panel, ideally including ApoB, provides a more accurate cardiovascular risk picture.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: REFS_LIPID_GUIDELINES,
  },

  'hdl-low': {
    reason: 'Low HDL cholesterol is associated with increased cardiovascular risk. Unlike LDL, HDL is generally considered protective — it helps remove cholesterol from arteries. Regular exercise and healthy fats (olive oil, nuts, avocado) can help raise HDL levels. Weight loss also improves HDL.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: REFS_LIPID_GUIDELINES,
  },

  'trig-very-high': {
    reason: 'Very high triglycerides (≥500 mg/dL / ≥5.64 mmol/L) carry an acute risk of pancreatitis — inflammation of the pancreas that can be life-threatening. This requires immediate medical attention and aggressive dietary intervention (strict alcohol and sugar avoidance, calorie reduction).',
    guidelines: [...GUIDELINES_LIPIDS],
    references: REFS_LIPID_GUIDELINES,
  },

  // ── Blood Pressure ─────────────────────────────────────────

  'bp-crisis': {
    reason: 'A blood pressure reading this high (≥180/120 mmHg) is classified as a hypertensive crisis. If accompanied by symptoms such as chest pain, shortness of breath, severe headache, or vision changes, this is a medical emergency requiring immediate attention.',
    guidelines: [...GUIDELINES_BP],
    references: [...REFS_BP_LIFESTYLE, ...REFS_BP_TRIALS],
  },

  'bp-stage2': {
    reason: 'Stage 2 hypertension (≥140/90 mmHg) significantly increases the risk of heart attack, stroke, kidney disease, and heart failure. At this level, medication is typically recommended alongside lifestyle measures.\n\nDr Stanfield targets <120/80 mmHg for adults under 65, based on the SPRINT trial (9,300 participants), which showed that intensive blood pressure lowering to <120 mmHg significantly reduced cardiovascular events and mortality compared to the standard <140 mmHg target. The ESPRIT trial (11,255 participants) confirmed these benefits extend to patients with diabetes and prior stroke.',
    guidelines: [...GUIDELINES_BP, 'SPRINT 2015', 'ESPRIT 2024'],
    references: [...REFS_BP_LIFESTYLE, ...REFS_SODIUM, ...REFS_BP_TRIALS],
  },

  'bp-stage1': {
    reason: 'Stage 1 hypertension (130–139/80–89 mmHg) is the point at which blood pressure starts to cause meaningful cardiovascular damage over time. Lifestyle measures are the first-line treatment: reduce sodium, increase potassium-rich foods, exercise regularly, prioritise sleep, and manage weight.\n\nDr Stanfield targets <120/80 mmHg for adults under 65. The SPRINT trial showed that targeting <120 mmHg (vs <140 mmHg) reduced cardiovascular events by 25% and all-cause mortality by 27%. The ESPRIT trial extended these findings to a broader population including those with diabetes.',
    guidelines: [...GUIDELINES_BP, 'SPRINT 2015', 'ESPRIT 2024'],
    references: [...REFS_BP_LIFESTYLE, ...REFS_SODIUM, ...REFS_BP_TRIALS],
  },

  // ── Cholesterol Medication Cascade ─────────────────────────

  'med-statin': {
    reason: 'Statins are the cornerstone of cholesterol-lowering therapy. Both the AHA/ACC and ESC/EAS guidelines recommend statins as first-line treatment when lipid levels exceed targets. Statins reduce LDL/ApoB by inhibiting cholesterol synthesis in the liver, and large clinical trials consistently show they reduce cardiovascular events and mortality.\n\nDr Stanfield uses more aggressive on-treatment lipid targets (ApoB ≤50 mg/dL, LDL ≤54 mg/dL) based on the PESA study, which showed that even young, healthy adults develop subclinical atherosclerosis when exposed to elevated lipids over time. Multiple studies confirm that very low LDL levels are safe.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: [...REFS_LIPID_GUIDELINES, ...REFS_PESA, ...REFS_LDL_SAFETY],
  },

  'med-ezetimibe': {
    reason: 'Ezetimibe works differently from statins — it blocks cholesterol absorption in the intestine. Adding ezetimibe to a statin typically lowers LDL by an additional 15–20%. Recent evidence shows that starting ezetimibe early alongside a statin produces better cardiovascular outcomes than adding it later.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: [
      ...REFS_LIPID_GUIDELINES,
      { label: 'Leosdottir 2025 – Early vs late ezetimibe initiation (JACC)', url: 'https://doi.org/10.1016/j.jacc.2025.02.007' },
    ],
  },

  'med-bempedoic-acid': {
    reason: 'Bempedoic acid (Nexletol) inhibits ATP citrate lyase, lowering cholesterol production via a different pathway than statins. The CLEAR Outcomes trial showed a 13% reduction in major adverse cardiovascular events in statin-intolerant patients. It can be used alongside statins for additional LDL reduction. The combination pill with ezetimibe (Nexlizet) offers convenience.',
    guidelines: ['ACC/AHA 2026', 'ESC/EAS 2019'],
    references: [
      { label: 'Nissen 2023 – CLEAR Outcomes (bempedoic acid cardiovascular outcomes)', url: 'https://doi.org/10.1056/NEJMoa2215024' },
    ],
  },

  'med-statin-increase': {
    reason: 'Doubling the statin dose typically provides an additional 6–7% LDL reduction (the "rule of 6"). While each dose increase has diminishing returns, the cumulative benefit of reaching lower lipid targets is supported by guidelines and the PESA study evidence.',
    guidelines: ['ESC/EAS 2019', 'BPAC 2021'],
    references: [
      { label: 'Mach 2020 – ESC/EAS Dyslipidaemia Guidelines (Eur Heart J)', url: 'https://doi.org/10.1093/eurheartj/ehz455' },
    ],
  },

  'med-statin-switch': {
    reason: 'Different statins vary in potency. Rosuvastatin 40mg provides the highest LDL reduction (~63%), while some other statins max out at lower potencies. Switching to a more potent statin is recommended by ESC/EAS guidelines before adding additional medications.',
    guidelines: ['ESC/EAS 2019', 'BPAC 2021'],
    references: [
      { label: 'Mach 2020 – ESC/EAS Dyslipidaemia Guidelines (Eur Heart J)', url: 'https://doi.org/10.1093/eurheartj/ehz455' },
    ],
  },

  'med-pcsk9i': {
    reason: 'PCSK9 inhibitors (evolocumab, alirocumab) are injectable medications that can lower LDL by an additional 50–60% beyond statins. They are recommended by AHA/ACC and ESC/EAS guidelines when lipid targets are not met with maximally tolerated statin plus ezetimibe. They also lower Lp(a) by approximately 25–30%.',
    guidelines: [...GUIDELINES_LIPIDS],
    references: REFS_LIPID_GUIDELINES,
  },

  // ── Cancer Screening ───────────────────────────────────────

  'screening-colorectal': {
    reason: 'The American Cancer Society recommends colorectal screening starting at age 45 for average-risk adults. Dr Stanfield recommends starting at age 35 due to rising rates of early-onset colorectal cancer, particularly in adults under 50 — a global trend documented across multiple countries over recent decades. Screening options include annual stool-based testing (FIT) or colonoscopy every 10 years.',
    guidelines: ['ACS', 'Dr Stanfield'],
    references: [
      ...REFS_SCREENING_ACS,
      { label: 'Siegel 2019 – Rising early-onset colorectal cancer globally (Gut)', url: 'https://doi.org/10.1136/gutjnl-2019-319511' },
    ],
  },

  'screening-breast': {
    reason: 'Mammography screening reduces breast cancer mortality by detecting cancers early, when treatment is most effective. The ACS recommends annual mammograms starting at age 45 (optional from 40). The benefits and appropriate frequency should be discussed with your doctor based on your individual risk.',
    guidelines: ['ACS'],
    references: REFS_SCREENING_ACS,
  },

  'screening-cervical': {
    reason: 'Cervical screening (HPV testing or Pap smear) detects precancerous changes caused by human papillomavirus. Catching these changes early prevents cervical cancer from developing. HPV testing every 5 years is now preferred over Pap smears every 3 years due to higher sensitivity.',
    guidelines: ['ACS'],
    references: REFS_SCREENING_ACS,
  },

  'screening-lung': {
    reason: 'The USPSTF recommends annual low-dose CT screening for adults aged 50–80 with a smoking history of ≥15 pack-years (current or former smokers). Low-dose CT can detect lung cancer at an early, treatable stage, significantly reducing lung cancer mortality.',
    guidelines: ['USPSTF 2021'],
    references: [
      ...REFS_SCREENING_ACS,
      { label: 'USPSTF – Lung Cancer Screening Recommendation', url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/lung-cancer-screening' },
    ],
  },

  'screening-prostate': {
    reason: 'Prostate cancer screening via PSA testing is a shared decision between patient and doctor. The benefits (early detection) must be weighed against the risks (overdiagnosis and overtreatment of slow-growing cancers). Long-term follow-up of the Prostate Cancer Prevention Trial showed that 5-alpha reductase inhibitors can reduce prostate cancer incidence.',
    guidelines: [],
    references: [
      ...REFS_SCREENING_ACS,
      { label: 'Goodman 2019 – Finasteride & prostate cancer mortality (NEJM)', url: 'https://doi.org/10.1056/NEJMc1809961' },
    ],
  },

  'screening-prostate-elevated': {
    reason: 'A PSA above 4.0 ng/mL is above the typical reference range, but elevated PSA can have multiple causes including benign prostatic hyperplasia (BPH), infection, or prostate cancer. Further evaluation by your doctor is needed to determine the cause.',
    guidelines: [],
    references: REFS_SCREENING_ACS,
  },

  'screening-endometrial-bleeding': {
    reason: 'Abnormal uterine bleeding — especially after menopause — can be an early sign of endometrial cancer. Prompt evaluation is important because endometrial cancer detected early has a very high cure rate.',
    guidelines: ['ACS'],
    references: REFS_SCREENING_ACS,
  },

  'screening-endometrial': {
    reason: 'Women at menopause should be aware of the symptoms of endometrial cancer, particularly unexpected vaginal bleeding. The ACS recommends that women be informed about risks and symptoms at the onset of menopause.',
    guidelines: ['ACS'],
    references: REFS_SCREENING_ACS,
  },

  'screening-dexa': {
    reason: 'A DEXA scan measures bone mineral density and can detect osteoporosis before a fracture occurs. Early detection allows treatment with medications that reduce fracture risk. The USPSTF recommends screening for women aged 65+ and postmenopausal women under 65 with risk factors.',
    guidelines: ['USPSTF'],
    references: [
      { label: 'USPSTF – Osteoporosis Screening Recommendation', url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/osteoporosis-screening' },
    ],
  },

  // ── Supplements ────────────────────────────────────────────

  'supplement-micronutrient-base': {
    reason: 'A comprehensive daily supplement can help fill nutritional gaps. A COSMOS trial sub-study found that daily multivitamin use improved cognitive function in older adults, suggesting broad micronutrient support may benefit brain health alongside physical health.',
    guidelines: [],
    references: [
      { label: 'Baker 2023 – Multivitamin & cognitive function: COSMOS trial (Alzheimers Dement)', url: 'https://doi.org/10.1002/alz.12767' },
    ],
  },

  'supplement-creatine': {
    reason: 'Creatine monohydrate is one of the most well-studied supplements. A meta-analysis found it significantly increases muscle strength and lean mass when combined with resistance training, and emerging evidence suggests cognitive benefits, particularly under conditions of stress or sleep deprivation.',
    guidelines: [],
    references: [
      { label: 'Kreider 2017 – ISSN position stand: creatine safety & efficacy (J Int Soc Sports Nutr)', url: 'https://doi.org/10.1186/s12970-017-0173-z' },
      { label: 'Avgerinos 2018 – Creatine & cognition: systematic review (Exp Gerontol)', url: 'https://doi.org/10.1016/j.exger.2018.04.013' },
    ],
  },

  'supplement-collagen': {
    reason: 'A 2023 meta-analysis combining 26 randomised controlled trials confirmed that oral collagen peptide supplementation significantly improves skin hydration and elasticity compared with placebo, with effects observed at doses of 10–15 g daily.',
    guidelines: [],
    references: [
      { label: 'Pu 2023 – Collagen peptides & skin: meta-analysis of 26 RCTs (Nutrients)', url: 'https://doi.org/10.3390/nu15092080' },
    ],
  },

  'supplement-omega3': {
    reason: 'An updated meta-analysis of interventional trials found that omega-3 supplementation reduces cardiovascular events and cardiac death, with benefits increasing at higher doses. The effect appears strongest for EPA-rich formulations.\n\nOmega-3 also plays an important role in cognitive protection. Randomised trials found that B vitamin supplementation slowed brain atrophy by 40% — but only in participants with adequate omega-3 levels. When omega-3 was low, B vitamins had no effect. This suggests that combining omega-3 with a B-complex supplement may provide synergistic neuroprotective benefits.',
    guidelines: [],
    references: [
      { label: 'Bernasconi 2021 – Omega-3 dose & cardiovascular outcomes (Mayo Clin Proc)', url: 'https://doi.org/10.1016/j.mayocp.2020.08.034' },
      { label: 'Jernerén 2015 – B vitamins + omega-3 slow brain atrophy (Am J Clin Nutr)', url: 'https://doi.org/10.3945/ajcn.114.103283' },
      { label: 'Oulhaj 2016 – Omega-3 enhances B vitamin cognitive protection (J Alzheimers Dis)', url: 'https://doi.org/10.3233/JAD-150777' },
    ],
  },

  'supplement-sleep': {
    reason: 'An umbrella review of meta-analyses confirms that melatonin supplementation effectively reduces sleep onset latency and improves sleep quality, with a good safety profile. This supports its use as part of a comprehensive sleep hygiene strategy.',
    guidelines: [],
    references: [
      { label: 'Low 2020 – Melatonin efficacy for insomnia (J Psychiatr Res)', url: 'https://doi.org/10.1016/j.jpsychires.2019.10.022' },
    ],
  },

  // ── Skin Health ────────────────────────────────────────────

  'skin-moisturizer': {
    reason: 'Ceramides are the primary lipids in the skin barrier — a randomised trial showed ceramide-containing moisturisers significantly improved skin hydration and barrier function for up to 7 days. Niacinamide (vitamin B3) is a well-studied ingredient that reduces pigmentation, improves skin texture, and enhances the skin barrier.',
    guidelines: [],
    references: [
      { label: 'Lueangarun 2019 – Ceramide moisturiser efficacy (Dermatol Ther)', url: 'https://doi.org/10.1111/dth.13090' },
      { label: 'Hakozaki 2002 – Niacinamide reduces pigmentation (Br J Dermatol)', url: 'https://doi.org/10.1046/j.1365-2133.2002.04834.x' },
    ],
  },

  'skin-sunscreen': {
    reason: 'A landmark randomised trial (Hughes 2013) proved that daily sunscreen use prevents skin aging — not just sunburn, but the wrinkles, texture changes, and pigmentation caused by UV exposure. Daily broad-spectrum SPF 50+ sunscreen applied to exposed skin is one of the most evidence-backed anti-aging interventions available.',
    guidelines: [],
    references: [
      { label: 'Hughes 2013 – Sunscreen prevents skin aging: randomised trial (Ann Intern Med)', url: 'https://doi.org/10.7326/0003-4819-158-11-201306040-00002' },
      { label: 'Randhawa 2016 – Daily sunscreen improves photoaging (Dermatol Surg)', url: 'https://doi.org/10.1097/DSS.0000000000000879' },
    ],
  },

  'skin-retinoid': {
    reason: 'Retinoids (vitamin A derivatives) are the most studied topical anti-aging treatment. They stimulate collagen production, accelerate cell turnover, and improve skin texture. A randomised trial found adapalene 0.3% comparable in efficacy to tretinoin 0.05% for treating photoaging, with better tolerability. Caution: retinoids must not be used during pregnancy.',
    guidelines: [],
    references: [
      { label: 'Bagatin 2018 – Adapalene vs tretinoin for photoaging (Eur J Dermatol)', url: 'https://doi.org/10.1684/ejd.2018.3320' },
      { label: 'Zasada 2019 – Retinoids in skin treatments (Postepy Dermatol Alergol)', url: 'https://doi.org/10.5114/ada.2019.87443' },
    ],
  },

  'skin-advanced': {
    reason: 'For those seeking additional skin rejuvenation, several evidence-based professional treatments exist. Red light therapy (630–850nm) was shown in a controlled trial to significantly reduce wrinkles and increase collagen density. Resistance training has also been shown to improve dermal structure. Other professional options include fractional laser, IPL, and microneedling.',
    guidelines: [],
    references: [
      { label: 'Wunsch 2014 – Red light therapy for skin rejuvenation (Photomed Laser Surg)', url: 'https://doi.org/10.1089/pho.2013.3616' },
      { label: 'Nishikori 2023 – Resistance training rejuvenates skin (Sci Rep)', url: 'https://doi.org/10.1038/s41598-023-37207-9' },
    ],
  },
};

// ============================================================
// Stat card evidence (expandable detail for health snapshot cards)
// ============================================================

const REFS_BMI: SuggestionReference[] = [
  { label: 'Global BMI Mortality Collaboration 2016 – BMI & all-cause mortality (Lancet)', url: 'https://doi.org/10.1016/S0140-6736(16)30175-1' },
  { label: 'Ashwell 2012 – WHtR better than BMI for cardiometabolic risk (Obes Rev)', url: 'https://doi.org/10.1111/j.1467-789X.2011.00952.x' },
];

const REFS_EGFR: SuggestionReference[] = [
  { label: 'Inker 2021 – CKD-EPI 2021 race-free eGFR equation (NEJM)', url: 'https://doi.org/10.1056/NEJMoa2102953' },
];

const REFS_IBW: SuggestionReference[] = [
  { label: 'Peterson 2016 – Universal equation for ideal body weight (Am J Clin Nutr)', url: 'https://doi.org/10.3945/ajcn.115.121178' },
];

const REFS_WHTR: SuggestionReference[] = [
  { label: 'Ashwell & Hsieh 2005 – WHtR as screening tool for metabolic risk (Obes Rev)', url: 'https://doi.org/10.1111/j.1467-789X.2005.00165.x' },
];

/** Static stat card evidence entries. */
export const STAT_CARD_EVIDENCE: Record<string, SuggestionEvidence> = {
  'apob': {
    reason: 'Apolipoprotein B (ApoB) counts the total number of atherogenic lipoprotein particles in your blood and is the most accurate single predictor of cardiovascular risk — more precise than LDL-cholesterol, which only measures cholesterol content. Each atherogenic particle carries exactly one ApoB molecule. The 2026 ACC/AHA Dyslipidemia Guideline recommends ApoB measurement to assess residual ASCVD risk, with treatment targets based on cardiovascular risk category: below 90 mg/dL for borderline-intermediate risk, below 70 mg/dL for high risk, and below 55 mg/dL for very high risk. ApoB is preferred over LDL-C because it captures all atherogenic particles including VLDL remnants and Lp(a).',
    guidelines: ['ACC/AHA 2026', 'ESC/EAS 2019'],
    references: [
      ...REFS_LIPID_GUIDELINES,
      { label: 'Borén 2020 – LDL causes atherosclerosis: EAS consensus (Eur Heart J)', url: 'https://doi.org/10.1093/eurheartj/ehz962' },
      { label: 'Sniderman 2019 – ApoB & cardiovascular disease (JAMA Cardiol)', url: 'https://doi.org/10.1001/jamacardio.2019.3780' },
    ],
  },

  'non-hdl': {
    reason: 'Non-HDL cholesterol (total cholesterol minus HDL) captures all atherogenic lipoproteins. It is the second-best predictor of cardiovascular risk after ApoB. The 2026 ACC/AHA guideline establishes non-HDL-C goals aligned with LDL-C targets (approximately 30 mg/dL higher). Note: ApoB is the most accurate single marker — if available, ask your doctor about testing ApoB.',
    guidelines: ['ACC/AHA 2026', 'ESC/EAS 2019'],
    references: REFS_LIPID_EVIDENCE,
  },

  'ldl': {
    reason: 'LDL-cholesterol measures the cholesterol carried by low-density lipoproteins. The 2026 ACC/AHA Dyslipidemia Guideline reinstates explicit LDL-C treatment targets based on cardiovascular risk category: below 100 mg/dL for borderline-intermediate risk, below 70 mg/dL for high risk, and below 55 mg/dL for very high risk. Note: LDL-C can underestimate risk in people with high triglycerides or metabolic syndrome. ApoB or Non-HDL are preferred when available.',
    guidelines: ['ACC/AHA 2026', 'ESC/EAS 2019'],
    references: REFS_LIPID_EVIDENCE,
  },

  'egfr': {
    reason: 'Estimated glomerular filtration rate (eGFR) measures kidney function using the CKD-EPI 2021 equation (race-free), based on creatinine, age, and sex. CKD staging: ≥70 Normal, 60-69 Low Normal, 45-59 Mildly Decreased (Stage 3a), 30-44 Moderately Decreased (Stage 3b), 15-29 Severely Decreased (Stage 4), <15 Kidney Failure (Stage 5). An eGFR below 60 sustained for 3+ months is consistent with chronic kidney disease.',
    guidelines: ['KDIGO'],
    references: REFS_EGFR,
  },

  'lpa': {
    reason: 'Lipoprotein(a) is genetically determined — your level is largely set by your DNA and not significantly modifiable by diet or lifestyle. The 2026 ACC/AHA Dyslipidemia Guideline recommends measuring Lp(a) at least once in all adults (Class I recommendation). Levels ≥125 nmol/L are associated with elevated cardiovascular risk. Since Lp(a) itself cannot currently be lowered, the strategy is to aggressively reduce all other modifiable risk factors. A single lifetime measurement is usually sufficient.',
    guidelines: ['ACC/AHA 2026', 'EAS 2022'],
    references: REFS_LPA,
  },

  'whtr': {
    reason: 'Waist-to-height ratio is a simple measure of central adiposity — a ratio ≥0.5 indicates elevated metabolic risk from visceral fat. It is more discriminative than BMI alone because it captures abdominal fat distribution, which is more strongly associated with cardiovascular disease, type 2 diabetes, and metabolic syndrome than overall body weight. The threshold of 0.5 applies regardless of sex, age, or ethnicity.',
    guidelines: ['NICE'],
    references: REFS_WHTR,
  },

  'hba1c': {
    reason: 'HbA1c (glycated haemoglobin) reflects average blood sugar over the past 2–3 months. ADA thresholds: <5.7% (<38.8 mmol/mol) Normal, 5.7–6.4% (38.8–47.4 mmol/mol) Prediabetic — a critical window where lifestyle change can prevent type 2 diabetes — and ≥6.5% (≥47.5 mmol/mol) Diabetic, requiring medical management to prevent cardiovascular, kidney, nerve, and vision complications.',
    guidelines: ['ADA'],
    references: [
      { label: 'ADA – Standards of Medical Care in Diabetes', url: 'https://diabetesjournals.org/care/issue/47/Supplement_1' },
    ],
  },
};

/** Build IBW stat card evidence with sex-specific detail. */
export function getIbwEvidence(sex: 'male' | 'female'): SuggestionEvidence {
  const bmiTarget = sex === 'male' ? 24 : 22;
  const range = sex === 'male' ? '23-26' : '20-23';
  return {
    reason: `Ideal Body Weight is calculated using the Peterson formula (2016): IBW = 2.2 × BMI_target + 3.5 × BMI_target × (height_m − 1.5). The target BMI is ${bmiTarget} for ${sex}s, derived from large mortality meta-analyses showing this BMI is associated with the lowest all-cause mortality (optimal range: ${range}). Unlike the older Devine formula (1974), the Peterson formula accounts for both sex and height, producing more physiologically accurate estimates.`,
    guidelines: [],
    references: REFS_IBW,
  };
}

/** Build protein stat card evidence with eGFR-aware detail. */
export function getProteinEvidence(ibwKg: number, proteinRate: number, eGFR?: number): SuggestionEvidence {
  const ckdNote = eGFR !== undefined && eGFR < 45
    ? ' Your protein target is reduced to 1.0g/kg due to kidney function (eGFR < 45 mL/min). High protein intake may accelerate kidney decline in CKD Stage 3b+.'
    : '';
  return {
    reason: `Daily protein target is calculated as ${proteinRate.toFixed(1)}g per kg of ideal body weight (${ibwKg} kg). Higher protein intake (≥1.2g/kg/day) supports muscle protein synthesis and helps preserve lean mass, particularly important for adults over 40. A meta-analysis of 49 studies found that higher protein intake was associated with reduced all-cause mortality.${ckdNote}`,
    guidelines: ['ISSN 2017'],
    references: REFS_PROTEIN,
  };
}

/** Build BMI stat card evidence with WHtR-aware detail. */
export function getBmiEvidence(bmiCategory: string, sex: 'male' | 'female', waistToHeightRatio?: number): SuggestionEvidence {
  const range = sex === 'male' ? '23-26' : '20-23';
  let whtrNote = '';
  if (bmiCategory === 'Overweight' && waistToHeightRatio !== undefined && waistToHeightRatio < 0.5) {
    whtrNote = '\n\nAlthough your BMI is 25-29.9, your waist-to-height ratio is below 0.5, which reclassifies you as Normal per AACE 2025 guidelines. This is because central adiposity (measured by WHtR) is a better predictor of metabolic risk than BMI alone.';
  } else if (bmiCategory === 'Overweight' && waistToHeightRatio === undefined) {
    whtrNote = '\n\nMeasuring your waist circumference would help refine this — a waist-to-height ratio <0.5 can reclassify Overweight BMI as Normal per AACE 2025.';
  }
  const guidelines = whtrNote ? ['AACE 2025'] : [];
  return {
    reason: `Body Mass Index = weight (kg) / height (m)². Sex-specific optimal BMI ranges based on mortality meta-analyses: males 23-26, females 20-23. Your optimal range is ${range}.${whtrNote}`,
    guidelines,
    references: REFS_BMI,
  };
}
