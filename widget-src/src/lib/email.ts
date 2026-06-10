/**
 * Loose email shape check for UX gating only ("did you typo this?") — the
 * server (zod .email()) is the real validator. Shared by the guest report
 * capture (ResultsPanel) and the reminders marketing opt-in.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
