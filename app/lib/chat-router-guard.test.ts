/**
 * US-15 AC25 — which routed pathways the chat may name.
 *
 * Router rule 2 forbids a children, pregnancy or palliative pathway without
 * the matching signal in the question. Sonnet 5.5 breaks it when no adult
 * entry exists (across runs on 2026-09-29, "I feel anxious all the time" got
 * youth, palliative, perinatal and adult suicide pathways), and "Articles read:" showed the
 * user those titles. Every routed pathway still loads; only the title is
 * hidden (api.chat-stream.test.ts checks the content side).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { titledHandles, populationsOf } from './chat-router-guard';

describe('titledHandles (US-15 AC25)', () => {
  it('hides every population and crisis title from an adult anxiety question', () => {
    const q = 'I feel anxious all the time';
    const population = [
      'general-mental-health-in-youth',
      'anxiety-in-children-and-youth',
      'anxiety-distress-and-agitation-in-palliative-care',
      'perinatal-mental-health',
    ];
    expect(titledHandles(population, q)).toEqual([]);
    // With the adult suicide pathway added, as a crisis routing may return it, that title is hidden too.
    expect(titledHandles([...population, 'suicide-prevention-in-adults'], q)).toEqual([]);
    expect(titledHandles([...population, 'adult-mental-health-counselling-and-therapy'], q))
      .toEqual(['adult-mental-health-counselling-and-therapy']);
  });

  it('never titles a crisis pathway, even with a self-harm signal', () => {
    for (const q of [
      "I've been thinking about ending my life",
      'I keep hurting myself when stressed',
      'I don’t want to be alive anymore',
      'how do I support a friend who talks about suicide',
      'My husband says he wants to kill himself. How can I help?',
      'my daughter has been cutting herself',
      'I feel bad',
    ]) {
      expect(titledHandles(['suicide-prevention-in-adults', 'non-suicidal-deliberate-self-harm'], q), q).toEqual([]);
      expect(titledHandles(['suicide-prevention-in-youth'], q), q).toEqual([]);
    }
  });

  it('hides the palliative title for chemo fatigue: chemo is not in rule 2\'s closed list', () => {
    expect(titledHandles(
      ['fatigue', 'weakness-and-fatigue-in-palliative-care'],
      'chemo fatigue getting worse what can we do',
    )).toEqual(['fatigue']);
  });

  it("titles a children pathway for a daughter's handwriting", () => {
    expect(titledHandles(
      ['developmental-concerns-in-school-age-children'],
      "my daughter's handwriting is getting worse",
    )).toEqual(['developmental-concerns-in-school-age-children']);
  });

  it('titles constipation-in-children for a premature baby, hides the palliative one', () => {
    expect(titledHandles(
      ['constipation-in-children', 'constipation-in-palliative-care-and-oncology'],
      'iron drops making my premature baby constipated',
    )).toEqual(['constipation-in-children']);
  });

  it('titles a palliative pathway when the question names cancer', () => {
    expect(titledHandles(
      ['constipation-in-palliative-care-and-oncology'],
      'mum on morphine for cancer, no bowel movement',
    )).toEqual(['constipation-in-palliative-care-and-oncology']);
  });

  it('titles a palliative pathway when the question names hospice', () => {
    expect(titledHandles(
      ['nausea-and-vomiting-in-palliative-care'],
      "she's in hospice and can't keep anything down",
    )).toEqual(['nausea-and-vomiting-in-palliative-care']);
  });

  it("hides the palliative insomnia title for a plain \"I can't sleep\"", () => {
    expect(titledHandles(
      ['insomnia', 'sleep-disturbances-in-palliative-care'],
      "I can't sleep",
    )).toEqual(['insomnia']);
  });

  it('titles the pregnancy entry for itch in pregnancy', () => {
    expect(titledHandles(['rash-and-itch-in-pregnancy'], 'itchy at night in pregnancy'))
      .toEqual(['rash-and-itch-in-pregnancy']);
  });

  it('reads hyperemesis gravidarum as a pregnancy signal (fixture "diagnosed with HG")', () => {
    expect(titledHandles(
      ['nausea-and-vomiting-in-pregnancy'],
      "I've been diagnosed with HG and can't keep anything down",
    )).toEqual(['nausea-and-vomiting-in-pregnancy']);
  });

  it('reads HG as a pregnancy signal only with diagnostic context, never in "mm Hg" (R2)', () => {
    const h = 'hypertension-in-pregnancy-and-postpartum';
    expect(titledHandles([h], 'My blood pressure is 150/95 mm Hg')).toEqual([]);
    expect(titledHandles([h], 'my BP was 140/90 mmHg this morning')).toEqual([]);
    expect(titledHandles([h], "I've been diagnosed with HG")).toEqual([h]);
    expect(titledHandles([h], 'the hyperemesis is worse today')).toEqual([h]);
  });

  it('titles the perinatal entry for low mood after a birth', () => {
    expect(titledHandles(['perinatal-mental-health'], 'I feel low after having my baby'))
      .toEqual(['perinatal-mental-health']);
  });

  it('hides the perinatal title for an ordinary symptom duration in weeks (R1)', () => {
    expect(titledHandles(
      ['perinatal-mental-health'],
      'I feel anxious all the time for the last two weeks',
    )).toEqual([]);
    expect(titledHandles(['perinatal-mental-health'], 'I have had a cough for 3 weeks')).toEqual([]);
  });

  it('titles the pregnancy entries on a gestational age (R1)', () => {
    for (const q of ["I'm 38 weeks pregnant", '38 weeks along and my feet are swollen', '12 weeks and 3 days, is spotting normal?', 'at 20 weeks gestation'])
      expect(titledHandles(['perinatal-mental-health'], q), q).toEqual(['perinatal-mental-health']);
  });

  it('reads the earlier turns the router saw', () => {
    expect(titledHandles(
      ['cough-in-children'],
      'my son is 4\nhe has had a cough for a week',
    )).toEqual(['cough-in-children']);
  });

  it('counts a stated age as a child only up to 24', () => {
    expect(titledHandles(['anxiety-in-children-and-youth'], 'my 7yo is anxious'))
      .toEqual(['anxiety-in-children-and-youth']);
    expect(titledHandles(['anxiety-in-children-and-youth'], 'I am a 52 year old man and anxious'))
      .toEqual([]);
  });

  it('hides raised-intracranial-pressure (a palliative pathway by title) until the text says palliative (R2)', () => {
    const h = 'raised-intracranial-pressure';
    expect(titledHandles([h], 'morning headaches and vomiting')).toEqual([]);
    expect(titledHandles([h], 'morning headaches and vomiting, she is in palliative care')).toEqual([h]);
  });

  it('titles a mixed pathway only when every population it names has a signal', () => {
    const h = 'transitioning-paediatric-to-adult-palliative-care';
    expect(titledHandles([h], 'my son has cancer')).toEqual([h]);
    expect(titledHandles([h], 'my son is moving to adult care')).toEqual([]);
  });
});

describe('population markers against docs/blog/index.json (US-15 AC25)', () => {
  const handles = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'docs/blog/index.json'), 'utf-8')) as { handle: string }[])
    .map(e => e.handle);

  it('marks the population pathways whose handle lacks the population word, from their titles (R2)', () => {
    // Each title read in docs/blog/index.json on 2026-09-29.
    const byTitle: Record<string, string[]> = {
      palliative: ['fentanyl-guide', 'raised-intracranial-pressure'],
      paediatric: ['croup', 'failure-to-thrive', 'developmental-dysplasia-of-the-hip-ddh', 'impetigo'],
      pregnancy: ['fetal-renal-tract-dilatation', 'breast-engorgement-and-oversupply', 'mastitis-and-breast-abscess', 'recurrent-miscarriage', 'abortion-for-fetal-anomalies-or-genetic-disorders'],
    };
    for (const [p, hs] of Object.entries(byTitle)) for (const h of hs) {
      expect(handles, h).toContain(h);
      expect(populationsOf(h), h).toEqual([p]);
    }
  });

  it('pins how many index handles each population marks, so a new entry surfaces for review', () => {
    const counts = { paediatric: 0, pregnancy: 0, palliative: 0, crisis: 0 };
    for (const h of handles) for (const p of populationsOf(h)) counts[p]++;
    // Pinned 2026-09-29 after reading every marked handle: a new index entry
    // with a population word moves a count, and this names it for review.
    // Crisis: suicide-prevention-in-adults, suicide-prevention-in-youth,
    // non-suicidal-deliberate-self-harm.
    expect(counts).toEqual({ paediatric: 89, pregnancy: 32, palliative: 27, crisis: 3 });
    expect(populationsOf('suicide-prevention-in-adults')).toEqual(['crisis']);
  });

  it('never marks an adult or mixed-adult entry', () => {
    for (const h of [
      'poisoning-and-drug-overdose',
      'adult-mental-health-counselling-and-therapy',
      'sepsis-in-adults-young-people-and-pregnant-women',
      'acute-asthma-in-adults-and-young-people',
      'non-acute-asthma-in-adults-and-young-people',
      'epilepsy-in-women-and-pregnancy',
      'exercise-is-the-closest-thing-we-have-to-the-fountain-of-youth',
      'why-scientists-are-calling-taurine-the-youth-molecule',
      'spend-40-dollars-avoid-dying-early',
      'sub-fertility',
      'insomnia',
    ]) expect(populationsOf(h), h).toEqual([]);
  });
});
