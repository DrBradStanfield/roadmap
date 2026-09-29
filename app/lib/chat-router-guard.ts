/**
 * Which routed pathways the chat may name to the user (US-15 AC25).
 *
 * The stream lists the loaded articles by title: "Reading:" while the answer
 * is prepared, "Articles read:" after it. Router rule 2 (chat-router-prompt.md)
 * forbids a children, pregnancy or palliative pathway without that
 * population's signal, but the model breaks it when no adult entry exists:
 * across runs on 2026-09-29, "I feel anxious all the time" got youth,
 * palliative, perinatal and adult suicide pathways, and an anxious adult then
 * read "Suicide Prevention in Adults" under the answer.
 *
 * A display rule, never a content rule. Every routed pathway still loads into
 * the answer context. A closed signal list fails closed: as a content filter
 * it lost the pathway for crisis phrasings outside the list, "I'm 34 weeks
 * and have a bad headache" and "my two year old has a fever" (adversarial
 * review, 2026-09-29). Here a miss only hides a title.
 *
 * A population title shows only when the text carries that population's
 * signal. A crisis title (suicide, self-harm) never shows; the pathway still
 * loads. Any crisis handling in the answer is the model's default behaviour,
 * not a rule of ours: chat-system-prompt.md has no crisis line.
 *
 * A plain regex table, no NLP. A handle is marked by words in its own string,
 * or by name when only its index title names the population. The text is the
 * current question plus the earlier user turns the router saw. Pure and
 * import-free.
 */

export type Population = 'paediatric' | 'pregnancy' | 'palliative' | 'crisis';

// A stated age counts as a child up to 24, the upper edge of the youth pathways.
const AGE = /\b(\d{1,2})[\s-]*(?:years?[\s-]*old|yrs?[\s-]*old|y\/?o)\b/gi;
const hasChildAge = (text: string) => [...text.matchAll(AGE)].some(m => Number(m[1]) <= 24);

// An entry that names adults or women serves them too: no age or pregnancy mark.
const MIXED_ADULT = /(^|-)(adults|women)(-|$)/;

const RULES: { population: Population; handle: RegExp; byTitle?: string[]; signal: RegExp | null; orSignal?: (text: string) => boolean; spareMixedAdult?: true }[] = [
  {
    population: 'paediatric',
    handle: /(^|-)(child|children|infants?|infantile|babies|newborn|preterm|preschool|paediatric|school|young-people)(-|$)|(^|-)(in|and)-youth(-|$)|^youth-/,
    // Children's pathways by title: Croup; Failure to Thrive; Developmental
    // Dysplasia of the Hip; Impetigo (School Sores).
    byTitle: ['croup', 'failure-to-thrive', 'developmental-dysplasia-of-the-hip-ddh', 'impetigo'],
    signal: /\b(child|children|kids?|toddlers?|bab(y|ies)|infants?|newborns?|premature|prem(ie|mie)s?|preemies?|sons?|daughters?|grand(son|daughter|child|children|kids?)s?|boys?|girls?|teens?|teenagers?|teenage|adolescen\w*|youths?|young (people|person)|schools?|preschool\w*|students?|nursery|paediatric|pediatric|parenting|\d{1,2}[\s-]*(months?|mo|weeks?|wks?|days?)[\s-]*old)\b/i,
    orSignal: hasChildAge,
    spareMixedAdult: true,
  },
  {
    population: 'pregnancy',
    handle: /(^|-)(pregnancy|perinatal|antenatal|postnatal|postpartum|breastfeeding|lactation|caesarean)(-|$)/,
    // Pregnancy and lactation pathways by title: Fetal Renal Tract Dilatation;
    // Breast Engorgement and Oversupply; Mastitis and Breast Abscess; Recurrent
    // Miscarriage.
    byTitle: ['fetal-renal-tract-dilatation', 'breast-engorgement-and-oversupply', 'mastitis-and-breast-abscess', 'recurrent-miscarriage', 'abortion-for-fetal-anomalies-or-genetic-disorders'],
    // A number of weeks counts only with gestational context: "38 weeks along",
    // "12 weeks and 3 days". A bare "for two weeks" is a symptom duration.
    // HG counts only as a diagnosis: a bare "hg" matched "150/95 mm Hg".
    signal: /\b(pregnan\w*|trimester|\d{1,2}[\s-]*(weeks?|wks?)[\s-]*(along|gestation\w*|and \d days?)|breast[\s-]?fe(e|d)\w*|breastmilk|lactat\w*|nursing|milk supply|post[\s-]?partum|post[\s-]?natal|perinatal|ante[\s-]?natal|prenatal|ivf|conceiv\w*|ttc|miscarr\w*|bab(y|ies)|newborns?|birth|childbirth|labou?r|c[\s-]?section|caesarean|cesarean|vbac|midwife|expecting|morning sickness|hyperemesis|(diagnosed with|have|has|got) hg)\b/i,
    spareMixedAdult: true,
  },
  {
    population: 'palliative',
    handle: /(^|-)palliative(-|$)/,
    // Both titles end "(Palliative Care)".
    byTitle: ['fentanyl-guide', 'raised-intracranial-pressure'],
    // Closed list, the same words as router rule 2.
    signal: /\b(dying|hospice|terminal\w*|end[\s-]of[\s-]life|palliative|cancers?)\b/i,
  },
  {
    population: 'crisis',
    handle: /suicid|self-?harm/,
    // Never titled, whatever the text says.
    signal: null,
  },
];

/** The populations a handle is marked for, from its own string or its title. */
export function populationsOf(handle: string): Population[] {
  return RULES
    .filter(r => (r.handle.test(handle) && !(r.spareMixedAdult && MIXED_ADULT.test(handle))) || r.byTitle?.includes(handle))
    .map(r => r.population);
}

/** The handles whose titles may be shown: every population a handle is marked for has its signal in the text. */
export function titledHandles(handles: string[], text: string): string[] {
  const present = new Set(RULES.filter(r => r.signal?.test(text) || r.orSignal?.(text)).map(r => r.population));
  return handles.filter(h => populationsOf(h).every(p => present.has(p)));
}
