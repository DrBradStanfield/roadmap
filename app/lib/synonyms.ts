/**
 * Synonym equivalence sets for query expansion.
 *
 * Each array is a set of terms that all refer to the same concept. The
 * chatbot matcher checks the user's message against each set — if any term
 * in a set appears in the query, all OTHER terms in the set are added to
 * the search so the matcher can hit index keywords indexed under any
 * spelling, lay term, or abbreviation.
 *
 * Rules for adding a set:
 * 1. Every term must be safely interchangeable in a search context. "Tumor"
 *    and "cancer" are NOT — many tumors are benign. Don't conflate them.
 * 2. Avoid ambiguous short abbreviations without a word-boundary guard.
 *    "MI" matches "my", "minimum", "mine" via substring. For short
 *    abbreviations, prefer the word-boundary variant (e.g., " mi " or
 *    regex). We address this in the matcher, not here.
 * 3. Prefer shorter, atomic terms. Multi-word keywords require verbatim
 *    substring match — they're fragile. Include both the phrase and its
 *    atomic form when possible ("sleep apnea" AND "apnea").
 * 4. Every entry should solve a real failing query in
 *    tools/test-chatbot-matching.js, not be added speculatively.
 */

export const SYNONYM_SETS: string[][] = [
  // Cardiovascular
  ["hypertension", "high blood pressure", "hbp", "htn", "elevated blood pressure", "raised blood pressure"],
  ["myocardial infarction", "heart attack", "cardiac event", "acute coronary syndrome"],
  ["hyperlipidaemia", "hyperlipidemia", "high cholesterol", "raised cholesterol", "elevated cholesterol", "dyslipidaemia", "dyslipidemia"],

  // Metabolic
  ["type 2 diabetes", "t2dm", "t2d", "type ii diabetes", "diabetes mellitus"],
  ["hypothyroidism", "underactive thyroid", "low thyroid", "hashimoto"],
  ["hyperthyroidism", "overactive thyroid", "graves disease"],

  // Sleep (spelling variants + lay phrases)
  ["sleep apnoea", "sleep apnea", "osa", "obstructive sleep apnoea", "obstructive sleep apnea"],
  ["insomnia", "can't sleep", "cant sleep", "trouble sleeping", "difficulty sleeping", "can't fall asleep", "cant fall asleep", "unable to sleep"],
  ["snoring", "snore", "loud snoring", "snoring loudly", "snores loudly"],

  // GI
  ["gord", "gerd", "acid reflux", "reflux disease", "heartburn", "gastroesophageal reflux", "gastro-oesophageal reflux"],
  ["ibs", "irritable bowel syndrome", "irritable bowel"],
  ["dyspepsia", "indigestion", "upper abdominal pain"],

  // Mental health (lay/clinical)
  ["depression", "depressed", "low mood", "persistent sadness"],
  ["anxiety", "anxious", "anxiety disorder", "generalised anxiety", "generalized anxiety", "gad"],
  ["adhd", "attention deficit hyperactivity disorder", "attention deficit"],

  // Urinary / men's health
  ["bph", "benign prostatic hyperplasia", "enlarged prostate"],
  ["luts", "lower urinary tract symptoms", "nocturia", "trouble peeing", "trouble urinating", "urinary frequency", "getting up at night to pee", "waking up to pee"],
  ["erectile dysfunction", "ed", "impotence"],

  // Women's health
  ["postmenopausal bleeding", "bleeding after menopause", "pmb", "bleeding post menopause"],
  ["pcos", "polycystic ovary syndrome", "polycystic ovarian syndrome"],
  ["pid", "pelvic inflammatory disease"],
  ["bv", "bacterial vaginosis"],

  // Respiratory
  ["copd", "chronic obstructive pulmonary disease", "emphysema", "chronic bronchitis"],
  ["dyspnoea", "dyspnea", "shortness of breath", "breathlessness", "sob on exertion"],

  // Musculoskeletal
  ["adhesive capsulitis", "frozen shoulder"],
  ["osteoarthritis", "oa", "degenerative joint disease", "wear and tear arthritis"],

  // Symptom clusters commonly described in lay terms
  ["hypothyroid symptoms", "cold all the time", "weight gain fatigue", "always tired cold"],

  // Lab tests
  ["hba1c", "glycated haemoglobin", "a1c", "haemoglobin a1c"],
  ["ldl", "ldl-c", "ldl cholesterol", "low-density lipoprotein"],
  ["tsh", "thyroid stimulating hormone", "thyrotropin"],

  // Supplements / nutrients (commonly asked variants)
  ["omega-3", "omega 3", "fish oil", "omega three", "epa dha", "epa+dha"],
  ["vitamin b12", "b12", "cobalamin"],
  ["vitamin d", "vitamin d3", "cholecalciferol", "colecalciferol"],
];