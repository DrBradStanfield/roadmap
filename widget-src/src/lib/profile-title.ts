/** The profile section's title: "About you" where it sits low (US-62 AC12), else
 *  "Starting Info". The alcohol question's "I still drink" line names it too (US-60).
 *  Its own module so tests that mock InputPanel still get it. */
export const profileTitle = (aboutYouLow: boolean) => (aboutYouLow ? 'About you' : 'Starting Info');
