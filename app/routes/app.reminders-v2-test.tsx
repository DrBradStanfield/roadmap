import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData } from "react-router";

import { AdminTrigger } from "../components/AdminTrigger";
import { authenticateOwnerAdmin } from "../lib/admin-shop.server";
import { runAdminTrigger } from "../lib/admin-trigger.server";
import { processV2Reminders } from "../lib/reminder-v2-cron.server";

/**
 * Manual trigger for the v2 reminder cron. Bypasses the hour gate and the cron
 * lock: runs the processing pass NOW against the real reminder_optin_v2 table.
 * Re-send cooldowns still apply, so a second press won't spam anyone. It sends
 * real email to real people, so the run is a POST, not a page view.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticateOwnerAdmin(request);
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  return runAdminTrigger(request, async (startedAt) => ({
    sent: await processV2Reminders(startedAt.slice(0, 10)),
  }));
}

export default function RemindersV2Test() {
  const result = useActionData<typeof action>();

  return (
    <AdminTrigger
      heading="v2 reminders — manual cron trigger"
      blurb="Sends real reminder emails to everyone currently due. Cooldowns still apply."
      idleLabel="Run the reminder pass now"
      busyLabel="Running…"
    >
      {result?.ok === true && (
        <s-banner tone="success" heading={`Run complete — ${result.sent} email(s) sent`}>
          <s-paragraph>
            Started: {result.startedAt} · Completed: {result.completedAt}. Skip-reason
            breakdown is in the Fly logs (search "Reminder v2 cron summary").
          </s-paragraph>
        </s-banner>
      )}
      {result?.ok === false && (
        <s-banner tone="critical" heading="v2 reminder run threw an error">
          <s-paragraph>{result.errorMessage}</s-paragraph>
        </s-banner>
      )}
    </AdminTrigger>
  );
}
