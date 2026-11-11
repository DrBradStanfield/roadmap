/**
 * Evidence for the screening suggestions (cancer screening and DEXA).
 *
 * Split out of evidence.ts, which spreads SCREENING_EVIDENCE into
 * SUGGESTION_EVIDENCE at the same position, so key order is unchanged.
 * Part of the clinical three-file sync with health_roadmap_algorithm.md
 * and roadmap_text.html.
 */
import type { SuggestionEvidence, SuggestionReference } from './evidence';

const REFS_SCREENING_ACS: SuggestionReference[] = [
  { label: 'American Cancer Society – Screening Guidelines', url: 'https://www.cancer.org/cancer/screening/american-cancer-society-guidelines-for-the-early-detection-of-cancer.html' },
];

export const SCREENING_EVIDENCE: Record<string, SuggestionEvidence> = {
  'screening-colorectal': {
    reason: 'The American Cancer Society recommends colorectal screening starting at age 45 for average-risk adults. Some doctors recommend starting at age 35 due to rising rates of early-onset colorectal cancer, particularly in adults under 50 — a global trend documented across multiple countries over recent decades. Screening options include annual stool-based testing (FIT) or colonoscopy every 10 years.',
    guidelines: ['ACS'],
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
    reason: 'The American Cancer Society (2023) recommends annual low-dose CT screening for adults aged 50–80 who smoke or used to smoke and have a smoking history of 20 pack-years or more, however long ago they quit. The USPSTF (2021) also limits it to people who quit within the past 15 years; this plan follows the ACS because it does not ask when you quit. Low-dose CT can detect lung cancer at an early, treatable stage, significantly reducing lung cancer mortality. If a scan finds something that needs follow-up, the plan keeps that follow-up until it is done, even past age 80 or below 20 pack-years: finishing it is part of diagnosis, not routine screening.',
    guidelines: ['ACS 2023', 'USPSTF 2021'],
    references: [
      ...REFS_SCREENING_ACS,
      { label: 'Wolf 2023 – Screening for lung cancer: 2023 guideline update from the American Cancer Society (CA Cancer J Clin)', url: 'https://doi.org/10.3322/caac.21811' },
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
};
