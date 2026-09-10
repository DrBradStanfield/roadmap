import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData } from "react-router";

import { AdminTrigger, TriggerOutcome } from "../components/AdminTrigger";
import { authenticateOwnerAdmin } from "../lib/admin-shop.server";
import { runAdminTrigger } from "../lib/admin-trigger.server";
import { runYouTubeBotSummaryOnce } from "../lib/youtube-bot-summary-cron.server";

/**
 * Manual trigger for the YouTube bot digest — it sends a real email, so the
 * send is a POST, not a page view.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticateOwnerAdmin(request);
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  return runAdminTrigger(request, async () => {
    await runYouTubeBotSummaryOnce();
    return {};
  });
}

export default function YouTubeBotSummaryTest() {
  return (
    <AdminTrigger
      heading="YouTube bot summary — manual trigger"
      blurb="Sends the digest email now."
      idleLabel="Send the summary now"
      busyLabel="Sending…"
    >
      <TriggerOutcome
        result={useActionData<typeof action>()}
        successHeading="YouTube bot summary sent successfully"
        errorHeading="YouTube bot summary threw an error"
      />
    </AdminTrigger>
  );
}
