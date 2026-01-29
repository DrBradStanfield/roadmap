// Types
export type {
  HealthInputs,
  HealthResults,
  Suggestion,
  StoredHealthProfile,
  StoredBloodTest,
} from './types';

// Calculations
export {
  calculateIBW,
  calculateProteinTarget,
  calculateBMI,
  calculateWaistToHeight,
  calculateAge,
  getBMICategory,
  calculateHealthResults,
} from './calculations';

// Suggestions
export { generateSuggestions } from './suggestions';

// Validation
export {
  healthInputSchema,
  bloodTestSchema,
  validateHealthInputs,
  getValidationErrors,
  type ValidatedHealthInputs,
  type ValidatedBloodTest,
} from './validation';
