// A/B testing statistical significance — two-proportion z-test

// Abramowitz & Stegun rational approximation
export function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export function calculateSignificance(
  impressionsA: number, conversionsA: number,
  impressionsB: number, conversionsB: number,
): { pValue: number; confidence: string; relativeImprovement: number } {
  if (impressionsA < 100 || impressionsB < 100) {
    return { pValue: 1, confidence: 'Not enough data', relativeImprovement: 0 };
  }
  const pA = conversionsA / impressionsA;
  const pB = conversionsB / impressionsB;
  const pPool = (conversionsA + conversionsB) / (impressionsA + impressionsB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / impressionsA + 1 / impressionsB));
  if (se === 0) return { pValue: 1, confidence: 'No variance', relativeImprovement: 0 };
  const z = (pB - pA) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));
  const confidence = pValue <= 0.01 ? 'Highly significant (99%)'
    : pValue <= 0.05 ? 'Significant (95%)' : 'Not significant';
  const relativeImprovement = pA > 0 ? ((pB - pA) / pA) * 100 : 0;
  return { pValue, confidence, relativeImprovement };
}
