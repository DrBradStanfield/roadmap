/** BMI cut-offs in kg/m², each a lower bound of its class. getBMICategory,
 *  the plan's BMI rules and the BMI evidence note all read these, so the
 *  classes and the rules cannot drift apart (US-64, lead A2-3). */
export const BMI_THRESHOLDS = {
  normal: 18.5,
  overweight: 25,
  obese: 30, // class I
  obeseClass2: 35,
  obeseClass3: 40,
} as const;

/** Over this BMI, an elevated BMI category alone opens the weight-medicine
 *  card, with no other marker raised (US-06 AC6). */
export const BMI_WEIGHT_MEDICINE_ALONE = 28;
