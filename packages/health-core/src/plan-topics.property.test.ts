/**
 * US-62 AC39 (lead I-4): planTopics over 400 generated worlds (plan-topics.fixtures.ts). The
 * oracles never read planTopics' own rules: they count where each input suggestion lands, read
 * TOPICS' order, and check each owner's ruling (2026-11-25) from the input facts and the engine
 * functions the rulings name (`labTestSeries`). A failure prints the seed.
 */
import { describe, expect, it } from 'vitest';
import { labTestSeries } from './lab-series';
import type { TopicId } from './plan-sections';
import type { DerivedRow } from './plan-topics';
import { cardIds, genWorld, layoutOf, mulberry32, placedIds, rowName, run, SEEDS, shuffle, TOPIC_ORDER } from './plan-topics.fixtures';

describe('planTopics over generated plans (US-62 AC39)', () => {
  it('every suggestion is drawn: once as a card, or once on a question; an urgent placed one as both, in one topic', () => {
    for (const seed of SEEDS) {
      const w = genWorld(seed);
      const topics = run(w);
      const cards = topics.flatMap(cardIds);
      const placed = topics.flatMap(placedIds);
      for (const s of w.suggestions) {
        const inCards = cards.filter((id) => id === s.id).length;
        const onRows = placed.filter((id) => id === s.id).length;
        const where = `seed ${seed}, ${s.id} (${s.priority})`;
        expect(inCards + onRows, where).toBeGreaterThan(0);
        expect(inCards, where).toBeLessThanOrEqual(1);
        expect(onRows, where).toBeLessThanOrEqual(1);
        if (onRows === 1) expect(inCards, where).toBe(s.priority === 'urgent' ? 1 : 0);
        if (inCards + onRows === 2) expect(topics.filter((t) => cardIds(t).includes(s.id) && placedIds(t).includes(s.id)), where).toHaveLength(1);
      }
      expect(new Set([...cards, ...placed]), `seed ${seed}`).toEqual(new Set(w.suggestions.map((s) => s.id)));
    }
  });

  it('no topic comes back empty, and an urgent card sits over the rows, the rest under them', () => {
    for (const seed of SEEDS) {
      for (const t of run(genWorld(seed))) {
        expect(t.urgent.length + t.cards.length + t.rows.length + (t.questions ? 1 : 0), `seed ${seed}, ${t.topic}`).toBeGreaterThan(0);
        expect(t.urgent.every((c) => c.priority === 'urgent') && t.cards.every((c) => c.priority !== 'urgent'), `seed ${seed}, ${t.topic}`).toBe(true);
      }
    }
  });

  it("topics follow TOPICS' order, and the topics, rows and each topic's suggestions do not move when the plan's suggestions arrive in another order", () => {
    const shape = (topics: ReturnType<typeof run>) => topics.map((t) => [t.topic, t.rows.map(rowName), [...cardIds(t)].sort(), [...placedIds(t)].sort()]);
    for (const seed of SEEDS) {
      const w = genWorld(seed);
      const topics = run(w);
      const at = topics.map((t) => TOPIC_ORDER.indexOf(t.topic));
      expect(at, `seed ${seed}`).toEqual([...at].sort((a, b) => a - b));
      expect(new Set(at).size, `seed ${seed}`).toBe(at.length);
      expect(shape(run(w, shuffle(mulberry32(seed * 7919), w.suggestions))), `seed ${seed}`).toEqual(shape(topics));
    }
  });

  it('a topic shows by the rulings: the five standing ones always, Sleep and Fitness for a card or a device health source, Cancer screening for a note, a section or a card', () => {
    for (const seed of SEEDS) {
      const w = genWorld(seed);
      const topics = run(w);
      const withCards = new Set(topics.filter((t) => t.urgent.length + t.cards.length > 0).map((t) => t.topic));
      const f = w.facts;
      const expected = TOPIC_ORDER.filter((t: TopicId) => ['weight', 'bloodPressure', 'cholesterol', 'bloodTests', 'supplements'].includes(t)
        || withCards.has(t)
        || ((t === 'sleep' || t === 'fitness') && f.deviceHealth)
        || (t === 'screening' && (f.screeningNote || w.forms.screenings.length > 0)));
      expect(topics.map((t) => t.topic), `seed ${seed}`).toEqual(expected);
    }
  });

  it('rows by the rulings: a derived row when its value exists, the weight row unless asked beside the height, the lab rows labTestSeries gives', () => {
    const derived: DerivedRow[] = ['whtr', 'nonHdl', 'egfr'];
    for (const seed of SEEDS) {
      const w = genWorld(seed);
      const f = w.facts;
      const rows = new Map(run(w).map((t) => [t.topic, t.rows.map(rowName)]));
      const all = [...rows.values()].flat();
      const where = `seed ${seed}`;
      for (const d of derived) expect(all.includes(d), `${where}, ${d}`).toBe(f.derived[d]);
      expect(rows.get('weight')!.includes('weight'), where).toBe(!f.weightAskedWithHeight);
      const labKeys = labTestSeries(f.labValues, new Date('2026-11-25')).map((r) => `lab:${r.seriesKey}`);
      expect(rows.get('bloodTests')!.filter((n) => n.startsWith('lab:')), where).toEqual(f.derived.egfr ? labKeys.filter((k) => k !== 'lab:egfr') : labKeys);
      for (const t of ['sleep', 'fitness'] as const) expect(rows.get(t)?.includes('deviceHealth') ?? false, `${where}, ${t}`).toBe(f.deviceHealth);
    }
  });

  it('while a screening note shows, nothing is placed on the screening questions', () => {
    for (const seed of SEEDS) {
      const w = genWorld(seed);
      if (!w.facts.screeningNote) continue;
      expect(run(w).flatMap((t) => t.screenings), `seed ${seed}`).toEqual([]);
    }
  });

  it('before the form is full: no topics, every suggestion once in Other, and no other card before an urgent one', () => {
    for (const seed of SEEDS) {
      const w = genWorld(seed);
      const layout = layoutOf(w);
      expect(layout.kind, `seed ${seed}`).toBe(w.facts.formFull ? 'topics' : 'waiting');
      if (layout.kind !== 'waiting') continue;
      const ids = [...layout.urgent, ...layout.other].flatMap((c) => c.suggestions.map((s) => s.id));
      expect([...ids].sort(), `seed ${seed}`).toEqual(w.suggestions.map((s) => s.id).sort());
      // Drawn urgent then other, so every urgent card leads: none in `other`, only urgent ones in `urgent`.
      const urgent = (c: { priority: string }) => c.priority === 'urgent';
      expect([layout.urgent.every(urgent), layout.other.some(urgent)], `seed ${seed}`).toEqual([true, false]);
    }
  });
});
