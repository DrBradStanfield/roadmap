/**
 * Human-readable follow-up information for abnormal screening results.
 * Keyed by "{screeningType}_{method}".
 */
export const SCREENING_FOLLOWUP_INFO: Record<string, { followupName: string; abnormalMeans: string }> = {
  colorectal_fit_annual: { followupName: 'colonoscopy', abnormalMeans: 'positive FIT test' },
  colorectal_colonoscopy_10yr: { followupName: 'repeat colonoscopy', abnormalMeans: 'polyps found on colonoscopy' },
  colorectal_other: { followupName: 'follow-up investigation', abnormalMeans: 'abnormal result' },
  breast_annual: { followupName: 'diagnostic imaging/biopsy', abnormalMeans: 'abnormal mammogram' },
  breast_biennial: { followupName: 'diagnostic imaging/biopsy', abnormalMeans: 'abnormal mammogram' },
  cervical_hpv_every_5yr: { followupName: 'colposcopy', abnormalMeans: 'HPV positive result' },
  cervical_pap_every_3yr: { followupName: 'colposcopy', abnormalMeans: 'abnormal Pap test' },
  cervical_other: { followupName: 'colposcopy', abnormalMeans: 'abnormal result' },
  lung_annual_ldct: { followupName: 'follow-up imaging', abnormalMeans: 'abnormal LDCT result' },
  dexa_dexa_scan: { followupName: 'treatment review', abnormalMeans: 'osteoporosis diagnosed — treatment and monitoring required' },
};
