/**
 * The mode of the web's account check (US-09 AC55), read only by account-gate's
 * `checkMode`. observe: the outcome is counted; the sign-in is not affected.
 */
import type { AccountCheckMode } from '@roadmap/health-core/account-pin';

export const ACCOUNT_CHECK_MODE: AccountCheckMode = 'observe';
