/**
 * VO2 max fitness bands (US-56 AC8): display only, never a suggestion or a stored value.
 *
 * FRIEND 2022, Table 3, treadmill CPX with directly measured VO2peak, RER >= 1.0
 * (Kaminsky et al., Mayo Clin Proc 2022;97(2):285-293, doi:10.1016/j.mayocp.2021.08.020).
 * Low is below the 20th percentile, Below Average the 20th to below the 50th, Above
 * Average the 50th to below the 80th, High the 80th and above. Each band includes its
 * lower bound. Ages 20 to 89, by the table's decades.
 *
 * The table only: the iPhone app's engine serves the person's row on My data (`vo2Bands`,
 * ios/engine/my-data.ts), and the app applies its cut-points to a value (Vo2MaxBands.swift).
 */

export interface Vo2MaxCutPoints {
  fromAge: number;
  toAge: number;
  /** mL/kg/min */
  p20: number;
  p50: number;
  p80: number;
}

export const FRIEND_2022_TREADMILL: Record<'male' | 'female', readonly Vo2MaxCutPoints[]> = {
  male: [
    { fromAge: 20, toAge: 29, p20: 35.2, p50: 46.5, p80: 54.5 },
    { fromAge: 30, toAge: 39, p20: 29.8, p50: 39.7, p80: 50.0 },
    { fromAge: 40, toAge: 49, p20: 26.7, p50: 35.3, p80: 45.2 },
    { fromAge: 50, toAge: 59, p20: 22.2, p50: 29.2, p80: 38.3 },
    { fromAge: 60, toAge: 69, p20: 18.5, p50: 24.6, p80: 32.0 },
    { fromAge: 70, toAge: 79, p20: 15.9, p50: 20.6, p80: 25.9 },
    { fromAge: 80, toAge: 89, p20: 14.8, p50: 17.6, p80: 21.4 },
  ],
  female: [
    { fromAge: 20, toAge: 29, p20: 27.2, p50: 36.6, p80: 44.8 },
    { fromAge: 30, toAge: 39, p20: 21.9, p50: 28.3, p80: 37.0 },
    { fromAge: 40, toAge: 49, p20: 19.7, p50: 25.7, p80: 33.0 },
    { fromAge: 50, toAge: 59, p20: 18.5, p50: 22.9, p80: 28.4 },
    { fromAge: 60, toAge: 69, p20: 15.4, p50: 19.6, p80: 24.3 },
    { fromAge: 70, toAge: 79, p20: 14.0, p50: 17.2, p80: 20.8 },
    { fromAge: 80, toAge: 89, p20: 12.6, p50: 15.4, p80: 18.4 },
  ],
};
