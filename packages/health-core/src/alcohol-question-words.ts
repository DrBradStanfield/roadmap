// The words of the "Reduce alcohol intake" card's Dismiss question (US-60 AC3, AC4), one copy for
// both apps. The iPhone app keeps its own copy in Swift (ios/HealthRoadmap/Plan/PlanCardView.swift
// AlcoholQuestion) until it reads this one (lead M10b).

/** The question: a drinker is asked whether they still drink. */
export const alcoholQuestionTitle = (drinks: boolean) => (drinks ? 'Do you still drink alcohol?' : 'Do you drink alcohol?');

/** The line under the question. It names About you only where the page has its Alcohol row (US-60 AC4). */
export const alcoholQuestionMessage = (drinks: boolean, aboutYouRow?: boolean) => (drinks
  ? 'Tell us if this has changed.'
  : `Your answer is kept in your record, so your plan follows it on every device.${aboutYouRow ? ' You can change it in About you.' : ''}`);

/** Shown after "I still drink", which saves nothing; it names About you on the same condition. */
export const stillDrinkLine = (aboutYouRow?: boolean) => `This stays on your plan because the advice applies to anyone who drinks.${aboutYouRow ? ' You can change your answer in About you.' : ''}`;
