/**
 * The web's account check (US-09 AC55) runs in this one mode. 'observe': the
 * check decides and counts each outcome, pins follow the account that signed
 * in, and every sign-in proceeds as it did before the check. 'enforce': an
 * outcome that does not keep the sign-in refuses it.
 */
import type { AccountCheckMode } from '@roadmap/health-core/account-pin';

export const ACCOUNT_CHECK_MODE: AccountCheckMode = 'observe';
