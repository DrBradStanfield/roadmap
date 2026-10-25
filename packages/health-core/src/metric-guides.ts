/**
 * "About this measure" guides (US-58), shown below a metric's page in the iOS app
 * and behind each medication question's info button, as Apple Health does.
 *
 * DISPLAY-ONLY CLINICAL TEXT. A guide may only restate thresholds and claims that
 * health_roadmap_algorithm.md, evidence.ts and roadmap_text.html already hold, plus the
 * standard prescribing facts Brad approved (side effects, how a drug works; Brad
 * 2026-10-25). Sources are evidence.ts's own references, never a new citation.
 * metric-guides.test.ts holds both rules: every source resolves to an evidence.ts
 * reference, and every number is on its entry's list, found in the clinical files.
 *
 * Keys: metric types from mappings.ts (blood pressure as one, `blood_pressure`), height,
 * and MEDICATION_KEYS without the two escalation answers. The iOS engine serves them on
 * My data (ios/engine/my-data.ts), so a correction ships over the air (ios/architecture.md D3).
 */
import { SUGGESTION_EVIDENCE, STAT_CARD_EVIDENCE, getBmiEvidence, getIbwEvidence, type SuggestionReference } from './evidence';

export interface MetricGuide {
  title: string;
  whatItIs: string;
  whyItMatters: string;
  /** "How to measure", "How to prepare" or "How it works and side effects", then its points. */
  howTo: { heading: string; points: string[] };
  sources: SuggestionReference[];
}

const EVIDENCE_REFS = [
  ...Object.values(SUGGESTION_EVIDENCE), ...Object.values(STAT_CARD_EVIDENCE), getIbwEvidence('male'), getBmiEvidence(27, 'male'),
].flatMap((e) => e.references);

/** evidence.ts's reference whose label starts so; throws on none, so a renamed one fails every test that loads this file. */
function ref(labelStart: string): SuggestionReference {
  const found = EVIDENCE_REFS.find((r) => r.label.startsWith(labelStart));
  if (!found) throw new Error(`metric-guides: no evidence.ts reference starts "${labelStart}"`);
  return found;
}

const MEASURE = 'How to measure';
const PREPARE = 'How to prepare';
const WORKS = 'How it works and side effects';
const NO_FASTING = 'Most labs no longer require fasting for a cholesterol panel.';
const FAST_REPEAT = 'If your triglycerides come back high, your doctor may repeat the test after a fast.';
const TALK = 'If you notice side effects, talk to your doctor.';

export const METRIC_GUIDES: Record<string, MetricGuide> = {
  // ── Vitals ──────────────────────────────────────────────────
  weight: {
    title: 'Weight',
    whatItIs: 'Your body weight, measured on a scale. The app uses it with your height to work out your BMI.',
    whyItMatters: 'In large studies, weight well above or below the healthy range is linked with a higher risk of dying early. BMI alone can mislead in muscular people, so the plan reads it together with your waist.',
    howTo: { heading: MEASURE, points: [
      'Weigh at the same time of day. Morning, after the toilet and before eating, works well.',
      'Use the same scale, on a hard, flat floor, in light clothing.',
      'Day-to-day changes are mostly water. Watch the trend over weeks, not single days.',
    ] },
    sources: [ref('Global BMI Mortality Collaboration 2016'), ref('Peterson 2016')],
  },
  waist: {
    title: 'Waist',
    whatItIs: 'The distance around your belly. The app divides it by your height to give your waist-to-height ratio.',
    whyItMatters: 'Fat stored around the belly is more closely linked with heart disease and type 2 diabetes than overall weight is. The plan suggests keeping your waist below half your height.',
    howTo: { heading: MEASURE, points: [
      'Stand up straight and breathe out normally. Don\'t pull your stomach in.',
      'Wrap the tape around your bare belly, halfway between your lowest rib and the top of your hip bone.',
      'Keep the tape level and snug, without pressing into the skin.',
      'Measure at the same time of day each time.',
    ] },
    sources: [ref('Ashwell 2012')],
  },
  blood_pressure: {
    title: 'Blood pressure',
    whatItIs: 'The force of blood pushing on your artery walls, in mmHg. The top number (systolic) is the pressure as your heart beats. The bottom number (diastolic) is the pressure between beats.',
    whyItMatters: 'High blood pressure rarely causes symptoms. Over years it raises the risk of stroke, heart attack, and kidney damage. Trials show that lowering it reduces strokes and heart attacks.',
    howTo: { heading: MEASURE, points: [
      'Use an upper-arm cuff.',
      'Every 2 to 4 weeks is enough to see a trend.',
    ] },
    sources: [ref('Whelton 2017'), ref('SPRINT 2015')],
  },
  height: {
    title: 'Height',
    whatItIs: 'Your standing height. You enter it once in your profile rather than as a running record.',
    whyItMatters: 'Height is not a health marker by itself. The app needs it to work out your BMI, your waist-to-height ratio, your ideal body weight and the protein target built on it.',
    howTo: { heading: MEASURE, points: [
      'Stand barefoot with your heels, back and head against a wall, looking straight ahead.',
      'Rest a hardback book flat on your head, against the wall, and mark where its edge meets the wall.',
      'Measure from the floor to the mark.',
      'Adults rarely need to re-measure, though height can fall slowly with age.',
    ] },
    sources: [ref('Peterson 2016')],
  },

  // ── Blood tests ─────────────────────────────────────────────
  hba1c: {
    title: 'HbA1c',
    whatItIs: 'A blood test that shows how much sugar has stuck to your red blood cells. The result reflects your average blood sugar over the past 2 to 3 months.',
    whyItMatters: 'A raised HbA1c can show prediabetes or diabetes before symptoms appear. Diabetes raises the risk of heart disease, kidney damage, nerve damage and vision loss. At the prediabetes stage, lifestyle change can delay or prevent it.',
    howTo: { heading: PREPARE, points: [
      'No fasting is needed, and any time of day works.',
      'Anaemia, recent blood loss and some inherited haemoglobin variants can make the result unreliable. Your doctor may then use a glucose test.',
    ] },
    sources: [ref('ADA – Standards of Medical Care in Diabetes')],
  },
  creatinine: {
    title: 'Creatinine',
    whatItIs: 'A waste product made by your muscles and cleared by your kidneys. The app combines it with your age and sex to estimate how well your kidneys filter (eGFR), using the CKD-EPI 2021 equation.',
    whyItMatters: 'Kidney function can fall without any symptoms. eGFR helps spot chronic kidney disease early. The plan also uses it to set your protein target and decide whether extra potassium is safe.',
    howTo: { heading: PREPARE, points: [
      'No fasting is usually needed.',
      'Avoid hard exercise and a large meat meal the day before. Both can raise creatinine for a short time.',
      'Tell your doctor if you take creatine. It can raise creatinine without harming the kidneys.',
    ] },
    sources: [ref('Inker 2021')],
  },
  psa: {
    title: 'PSA',
    whatItIs: 'Prostate-specific antigen, a protein made by the prostate gland and measured in a blood test.',
    whyItMatters: 'PSA can rise with prostate cancer, but also with an enlarged prostate or an infection. Screening is a shared decision with your doctor. It can find cancer early, but it can also lead to treating slow-growing cancers that would never have caused harm.',
    howTo: { heading: PREPARE, points: [
      'Avoid ejaculation and long or hard cycling for 48 hours before the test.',
      'Wait until any urinary infection has fully cleared.',
      'Tell your doctor if you take finasteride or dutasteride. Both lower PSA, roughly by half, so the result needs adjusting.',
    ] },
    sources: [ref('American Cancer Society – Screening Guidelines'), ref('Goodman 2019')],
  },
  apob: {
    title: 'ApoB',
    whatItIs: 'Apolipoprotein B, a protein that sits once on every particle able to carry cholesterol into artery walls: LDL, VLDL, IDL and Lp(a). Measuring it counts those particles.',
    whyItMatters: 'These particles drive the build-up of plaque in arteries. Two people with the same LDL cholesterol can carry very different numbers of particles. That is why the plan uses ApoB as its first-choice cholesterol marker when you have a result.',
    howTo: { heading: PREPARE, points: [
      'No fasting is needed.',
      'Not every lab includes ApoB in a standard cholesterol panel, so you may need to ask for it.',
    ] },
    sources: [ref('Sniderman 2019'), ref('Borén 2020')],
  },
  ldl: {
    title: 'LDL cholesterol',
    whatItIs: 'The cholesterol carried in low-density lipoprotein particles, often called "bad" cholesterol. Most labs calculate it from total cholesterol, HDL and triglycerides. Some measure it directly.',
    whyItMatters: 'Genetic studies, trials and population data show that LDL causes plaque in artery walls, and that lowering it reduces heart attacks. The plan uses LDL when you have no ApoB or non-HDL result.',
    howTo: { heading: PREPARE, points: [NO_FASTING, FAST_REPEAT] },
    sources: [ref('Borén 2020'), ref('Navarese 2018')],
  },
  total_cholesterol: {
    title: 'Total cholesterol',
    whatItIs: 'All the cholesterol in your blood, across every type of particle, including HDL. The app subtracts your HDL from it to get your non-HDL cholesterol.',
    whyItMatters: 'On its own it is a rough guide, because it mixes particles that harm arteries with ones that protect them. Its main use in the plan is to work out non-HDL cholesterol: the cholesterol carried by all the particles that can build up in artery walls (ApoB counts those particles). When a better marker is already flagged, the plan does not show a separate total cholesterol card.',
    howTo: { heading: PREPARE, points: ['It comes in the same cholesterol panel as LDL and HDL.', NO_FASTING, FAST_REPEAT] },
    sources: [ref('2026 ACC/AHA Dyslipidemia Guideline'), ref('Grundy 2018')],
  },
  hdl: {
    title: 'HDL cholesterol',
    whatItIs: 'The cholesterol carried in high-density lipoprotein particles, often called "good" cholesterol. These particles help carry cholesterol away from artery walls and back to the liver.',
    whyItMatters: 'Low HDL is linked with a higher risk of heart disease. Regular exercise, weight loss and healthy fats such as olive oil, nuts and avocado can help raise it. The plan subtracts HDL from total cholesterol to get non-HDL cholesterol.',
    howTo: { heading: PREPARE, points: [
      'It comes in the standard cholesterol panel.', NO_FASTING, FAST_REPEAT,
      'Try to test at a time when your exercise and diet are typical for you.',
    ] },
    sources: [ref('2026 ACC/AHA Dyslipidemia Guideline'), ref('Mach 2020')],
  },
  triglycerides: {
    title: 'Triglycerides',
    whatItIs: 'The main form of fat in your blood. Your body stores spare energy as triglycerides, and the level rises for some hours after a meal.',
    whyItMatters: 'High triglycerides often go with excess weight, insulin resistance and alcohol. Particles rich in triglycerides carry ApoB and may add to artery plaque. Very high levels can inflame the pancreas, which needs prompt medical care.',
    howTo: { heading: PREPARE, points: [
      'Triglycerides are the cholesterol-panel result most changed by a recent meal.',
      'Most labs accept a non-fasting sample. If yours is high, your doctor may repeat it after a fast.',
    ] },
    sources: [ref('Ference 2019'), ref('2026 ACC/AHA Dyslipidemia Guideline'), ref('Mach 2020')],
  },
  lpa: {
    title: 'Lp(a)',
    whatItIs: 'Lipoprotein(a), a cholesterol-carrying particle like LDL with an extra protein attached. Your level is set mostly by your genes.',
    whyItMatters: 'A high Lp(a) is linked with a higher risk of heart disease and narrowing of the aortic valve. Diet and exercise barely change it, so when it is high the plan focuses on your other risk factors. The 2026 ACC/AHA guideline advises measuring it at least once in every adult.',
    howTo: { heading: PREPARE, points: [
      'No fasting is needed.',
      'One test is usually enough for life, because the level changes little.',
      'Labs report it in nmol/L, mg/dL or mg/L. The app accepts all three.',
    ] },
    sources: [ref('Kronenberg 2022'), ref('2026 ACC/AHA Dyslipidemia Guideline')],
  },

  // ── Medicines ───────────────────────────────────────────────
  statin: {
    title: 'Statins',
    whatItIs: 'Daily tablets that lower LDL cholesterol and ApoB. The app lists atorvastatin, rosuvastatin, pravastatin, simvastatin and pitavastatin.',
    whyItMatters: 'Large trials show statins reduce heart attacks, strokes and deaths from heart disease. Guidelines name them the first medicine to try when cholesterol stays above target.',
    howTo: { heading: WORKS, points: [
      'Statins slow cholesterol production in the liver, which then pulls more LDL out of the blood.',
      'Strength depends on both the drug and the dose.',
      'Muscle aches are the side effect people report most. A lower dose or a different statin often helps.',
      'Statins can raise blood sugar slightly, and some doctors check liver tests.',
      TALK,
    ] },
    sources: [ref('2026 ACC/AHA Dyslipidemia Guideline'), ref('Mach 2020'), ref('Navarese 2018')],
  },
  ezetimibe: {
    title: 'Ezetimibe',
    whatItIs: 'A daily 10 mg tablet that lowers LDL cholesterol. It is often added to a statin, and it also comes in combined pills.',
    whyItMatters: 'Added to a statin, ezetimibe typically lowers LDL by a further 15 to 20%. Starting it early after a heart attack was linked with better outcomes than adding it later.',
    howTo: { heading: WORKS, points: [
      'It blocks the gut from absorbing cholesterol, a different route from statins.',
      'It is also sold combined with a statin, or with bempedoic acid.',
      'Most people notice no side effects. Mild stomach upset can happen.',
      TALK,
    ] },
    sources: [ref('Leosdottir 2025'), ref('Lee 2026')],
  },
  bempedoic_acid: {
    title: 'Bempedoic acid',
    whatItIs: 'A daily 180 mg tablet (Nexletol) that lowers LDL cholesterol. It also comes combined with ezetimibe (Nexlizet).',
    whyItMatters: 'In the CLEAR Outcomes trial, people who could not take statins had 13% fewer major heart and blood vessel events on bempedoic acid. It can also be used alongside a statin for extra lowering.',
    howTo: { heading: WORKS, points: [
      'It lowers the cholesterol your liver makes, working at a different step from statins.',
      'It is activated in the liver but not in muscle, which may explain why muscle aches seem less common than with statins.',
      'It can raise uric acid, so mention it if you have had gout.',
      TALK,
    ] },
    sources: [ref('Nissen 2023')],
  },
  pcsk9i: {
    title: 'PCSK9 inhibitors',
    whatItIs: 'Medicines that lower LDL cholesterol by acting on PCSK9, a protein made in the liver. They come in three kinds: antibody injections such as evolocumab and alirocumab, given under the skin; inclisiran, also an injection; and oral PCSK9 inhibitors, which are newer.',
    whyItMatters: 'Guidelines recommend the antibody injections (evolocumab, alirocumab) when cholesterol stays above target on the highest tolerated statin plus ezetimibe. They can lower LDL by a further 50 to 60%, and Lp(a) by about 25 to 30%.',
    howTo: { heading: WORKS, points: [
      'PCSK9 is a protein that breaks down the liver\'s LDL receptors. Blocking it, or stopping the liver making it as inclisiran does, leaves more receptors to clear LDL from the blood.',
      'The most common side effect of the injections is redness or soreness where you inject.',
      'Cost and insurance approval can be hurdles.',
      TALK,
    ] },
    sources: [ref('2026 ACC/AHA Dyslipidemia Guideline'), ref('Mach 2020')],
  },
  glp1: {
    title: 'GLP-1 medications',
    whatItIs: 'Medicines that copy gut hormones, taken as a weekly injection or a daily tablet. The app lists semaglutide (Ozempic, Wegovy, Rybelsus), dulaglutide (Trulicity) and tirzepatide (Mounjaro, Zepbound), which acts on two hormones, GLP-1 and GIP.',
    whyItMatters: 'In large trials, semaglutide and tirzepatide led to substantial weight loss, with better blood sugar, blood pressure and triglycerides. Weight tends to return after stopping, so most people need them long term.',
    howTo: { heading: WORKS, points: [
      'They reduce appetite, slow stomach emptying and help release insulin after meals.',
      'Nausea, vomiting, diarrhoea and constipation are common, and usually ease over time.',
      'They are linked with a modestly higher risk of gallstones.',
      TALK,
    ] },
    sources: [ref('Wilding 2021'), ref('Wilding 2022')],
  },
  sglt2i: {
    title: 'SGLT2 inhibitors',
    whatItIs: 'Daily tablets first made for type 2 diabetes. The app lists empagliflozin (Jardiance), dapagliflozin (Farxiga) and canagliflozin (Invokana).',
    whyItMatters: 'Besides lowering blood sugar and causing modest weight loss, they protected the heart and kidneys in large trials, including in people with heart failure.',
    howTo: { heading: WORKS, points: [
      'They make your kidneys pass extra sugar out in your urine.',
      'Genital yeast infections are the most common side effect.',
      'They can cause dehydration, so drink enough, especially in hot weather.',
      'A rare but serious risk is ketoacidosis. Doctors often advise pausing them during illness, fasting or before surgery.',
      TALK,
    ] },
    sources: [ref('Zinman 2015'), ref('McMurray 2019')],
  },
  metformin: {
    title: 'Metformin',
    whatItIs: 'A daily tablet used for decades for type 2 diabetes. It comes as immediate release (IR) or extended release (XR).',
    whyItMatters: 'In the long-term follow-up of the Diabetes Prevention Program, people at high risk of type 2 diabetes who took metformin were no less likely to die, including from heart disease or cancer, than those on placebo.',
    howTo: { heading: WORKS, points: [
      'It lowers the sugar your liver releases and helps your body respond to insulin.',
      'Stomach upset and loose stools are common at first. The XR form may cause fewer.',
      'Long-term use can lower vitamin B12.',
      TALK,
    ] },
    sources: [ref('Lee 2021')],
  },
};
