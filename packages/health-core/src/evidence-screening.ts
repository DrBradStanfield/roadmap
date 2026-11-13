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
// What the ACS now says about PSA screening (guideline revised 2026-11-12).
const REF_ACS_PROSTATE: SuggestionReference = { label: 'American Cancer Society – Recommendations for Prostate Cancer Early Detection', url: 'https://www.cancer.org/cancer/types/prostate-cancer/detection-diagnosis-staging/acs-recommendations.html' };

export const SCREENING_EVIDENCE: Record<string, SuggestionEvidence> = {
  'screening-colorectal': {
    reason: 'Dr Brad recommends starting colorectal screening at age 35, because colorectal cancer in adults under 50 has become more common in many countries since the mid-1990s. This is his recommendation, not the official guideline: the American Cancer Society recommends starting at 45 for people at average risk and continuing through 75. Dr Brad suggests a stool test (FIT) every year until 55, then a colonoscopy every 10 years. This order is his suggestion; the American Cancer Society lists FIT every year and colonoscopy every 10 years, among other tests, as equal options from 45. After a positive test and a colonoscopy, follow the repeat interval in your colonoscopy report, which depends on what was found; if the report gave none, Dr Brad suggests repeating the colonoscopy every 3 years. This default is his recommendation, not a guideline figure.',
    guidelines: ['ACS 2018'],
    references: [
      ...REFS_SCREENING_ACS,
      { label: 'Siegel 2019 – Rising early-onset colorectal cancer globally (Gut)', url: 'https://doi.org/10.1136/gutjnl-2019-319511' },
      { label: 'Wolf 2018 – Colorectal cancer screening for average-risk adults: 2018 guideline update from the American Cancer Society (CA Cancer J Clin)', url: 'https://doi.org/10.3322/caac.21457' },
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
    reason: 'Prostate cancer screening via PSA testing is a shared decision between patient and doctor. The American Cancer Society (November 2026) recommends that men at average risk start at 50, and that Black men and men with a close relative (father, brother or son) who has had prostate cancer start at 45. It recommends a PSA test every year for Black men. For other men with a family history, it recommends every year if a close relative was diagnosed before 65 or more than one has had prostate cancer, and every 2 years if one close relative was diagnosed at 65 or older. The tool does not ask about these risks, so its suggestions are the same for every man. The benefits (early detection) must be weighed against the risks (overdiagnosis and overtreatment of slow-growing cancers). Long-term follow-up of the Prostate Cancer Prevention Trial showed that 5-alpha reductase inhibitors can reduce prostate cancer incidence. If you choose to be tested, Dr Brad suggests retesting every 2 years if your PSA is below 2.5 ng/mL, and every year if it is 2.5 or higher. These intervals are his suggestion, based on earlier American Cancer Society guidance. The Society\'s November 2026 guideline sets the interval by age and risk instead.',
    guidelines: [],
    references: [
      ...REFS_SCREENING_ACS,
      { label: 'Goodman 2019 – Finasteride & prostate cancer mortality (NEJM)', url: 'https://doi.org/10.1056/NEJMc1809961' },
      // What the ACS now says: the interval by age and risk. Not the source of the 2.5 intervals,
      // which are Dr Brad's, after earlier ACS guidance (Brad 2026-11-14).
      REF_ACS_PROSTATE,
    ],
  },

  'screening-prostate-elevated': {
    reason: 'Many doctors use a PSA of 4.0 ng/mL or higher as the level for further tests; some use a lower level. A raised PSA can have several causes, including an enlarged prostate (benign prostatic hyperplasia), infection or prostate cancer, and a level below 4.0 does not rule out cancer. Your doctor can help find the cause. Dr Brad suggests repeating the PSA every 3 months while it stays at 4.0 or higher, whether or not you chose routine screening. This is his suggestion; the American Cancer Society advises repeating a high PSA to confirm it, preferably 2 weeks to 3 months later.',
    guidelines: [],
    references: [
      ...REFS_SCREENING_ACS,
      // The 4.0 level and its causes (Brad 2026-11-12, PR 1358 R2).
      { label: 'American Cancer Society – Screening Tests for Prostate Cancer', url: 'https://www.cancer.org/cancer/types/prostate-cancer/detection-diagnosis-staging/tests.html' },
      // Repeating a high PSA to confirm it, 2 weeks to 3 months later (Brad 2026-11-14).
      REF_ACS_PROSTATE,
    ],
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
