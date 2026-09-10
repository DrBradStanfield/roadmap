import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData } from "react-router";

import { AdminTrigger, TriggerOutcome } from "../components/AdminTrigger";
import { authenticateOwnerAdmin } from "../lib/admin-shop.server";
import { runAdminTrigger } from "../lib/admin-trigger.server";
import { computeAndWriteTrending } from "../lib/trending-cron.server";

/**
 * Manual trigger for the trending cron — it rewrites live trending rows, so
 * the run is a POST, not a page view.
 *
 * Delete this route once trending cron is confirmed working.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticateOwnerAdmin(request);
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  return runAdminTrigger(request, async () => ({ entries: await computeAndWriteTrending() }));
}

export default function TrendingTest() {
  return (
    <AdminTrigger
      heading="Trending cron — manual trigger"
      blurb="Recomputes and overwrites the live trending rows."
      idleLabel="Run the trending cron now"
      busyLabel="Running…"
    >
      <TriggerOutcome
        result={useActionData<typeof action>()}
        successHeading="Trending cron ran successfully"
        errorHeading="Trending cron threw an error"
      />
    </AdminTrigger>
  );
}
