// The words of the "Reduce alcohol intake" card's Dismiss question (US-60 AC3, AC4), one copy for
// both apps. The iPhone app keeps its own copy in Swift (ios/HealthRoadmap/Plan/PlanCardView.swift
// AlcoholQuestion) until it reads this one (lead M10b).

/** The question: a drinker is asked whether they still drink. */
export const alcoholQuestionTitle = (drinks: boolean) => (drinks ? 'Do you still drink alcohol?' : 'Do you drink alcohol?');

/** The line under the question. It says the answer reaches every device only when the record is
 *  in a cloud (a record kept in this browser alone does not), and names About you only where the
 *  page has its Alcohol row (US-60 AC4, AC6). The iPhone's record is always in a cloud. */
export const alcoholQuestionMessage = (drinks: boolean, { inCloud, aboutYouRow }: { inCloud: boolean; aboutYouRow?: boolean }) => (drinks
  ? 'Tell us if this has changed.'
  : `Your answer is kept in your record${inCloud ? ', so your plan follows it on every device' : ''}.${aboutYouRow ? ' You can change it in About you.' : ''}`);

/** Shown after "I still drink", which saves nothing; it names About you on the same condition. */
export const stillDrinkLine = (aboutYouRow?: boolean) => `This stays on your plan because the advice applies to anyone who drinks.${aboutYouRow ? ' You can change your answer in About you.' : ''}`;
