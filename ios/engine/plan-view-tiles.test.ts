// US-25 AC22 (re-check F1): a tile the engine cannot draw never blanks the plan.
// statTiles is mocked to throw, so planViewJson must still return the sections.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { planJson, planViewJson, sectionsJson } from './entry';

vi.mock('../../packages/health-core/src/stat-tiles', () => ({
  statTiles: () => { throw new Error('tiles broken on purpose'); },
}));

const NOW = '2026-10-21T08:00:00.000Z';
const record = readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8');

describe('planViewJson when statTiles throws (US-25 AC22)', () => {
  it('gives no tiles and the sections intact', () => {
    const view = JSON.parse(planViewJson(record, NOW, 'phone', '{}'));
    expect(view.tiles).toEqual([]);
    const sections = JSON.parse(sectionsJson(planJson(record, NOW, 'phone', '{}')));
    expect(sections.length).toBeGreaterThan(0);
    expect(view.sections).toEqual(sections);
  });
});
