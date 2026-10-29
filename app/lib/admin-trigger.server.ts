import { data } from "react-router";

import { authenticateOwnerAdmin } from "./admin-shop.server";

/**
 * Run one manual admin trigger and report what happened.
 *
 * Every trigger page does the same three things — prove the owner, time the
 * run, turn a throw into something the page can render — and differs only in
 * the job. Keeping the shape here is what stops the next page getting the
 * important part wrong: this is an ACTION, never a loader, because a loader
 * fires on a plain visit (refresh, back button, admin prefetch) and these jobs
 * send real email and rewrite real rows.
 */
export async function runAdminTrigger<T extends object>(
  request: Request,
  job: (startedAt: string) => Promise<T>,
) {
  await authenticateOwnerAdmin(request);

  const startedAt = new Date().toISOString();
  try {
    const detail = await job(startedAt);
    return data({ ok: true as const, startedAt, completedAt: new Date().toISOString(), ...detail });
  } catch (error) {
    // The stack stays in the server log. TriggerOutcome prints the whole result
    // in a <pre>, so anything in it is on the page, and with ADMIN_SHOP_DOMAIN
    // unset any installing shop's admin can read it: no server paths or
    // dependency layout in the response (ID-2).
    console.error("Admin trigger failed:", error);
    return data({
      ok: false as const,
      startedAt,
      completedAt: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
