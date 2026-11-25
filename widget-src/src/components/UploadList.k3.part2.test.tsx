// @vitest-environment jsdom
/**
 * K3, the web upload list's screen property (US-13 AC26): seeds 41 to 80 of 120, split from one file to stay inside
 * CI's 40 s per-file budget (the file took 51.2 s on main). The harness, the properties and the mutations each was shown
 * failing on: testing/upload-list-k3.tsx.
 */
import { cleanup } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';
import { runSequence } from '../testing/upload-list-k3';

afterEach(cleanup);

describe('K3: the web upload list keeps the person\'s input and draws the engine (US-13 AC26)', () => {
  it('over seeded runs of interleaved screen and engine steps, seeds 41 to 80', () => {
    for (let seed = 41; seed < 81; seed++) runSequence(seed, 45);
  });
});
