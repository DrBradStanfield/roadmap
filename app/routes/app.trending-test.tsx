import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { computeAndWriteTrending } from "../lib/trending-cron.server";

/**
 * Temporary admin route to manually trigger the trending cron.
 *
 * Visit /app/trending-test in the Shopify admin to fire `computeAndWriteTrending()`
 * synchronously and see the result. HMAC-protected by `authenticate.admin`, so
 * only the merchant logged into the admin can hit it.
 *
 * Delete this route once trending cron is confirmed working.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  const startedAt = new Date().toISOString();
  try {
    const ranked = await computeAndWriteTrending();
    return data({
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
      entries: ranked,
    });
  } catch (error) {
    return data({
      ok: false,
      startedAt,
      completedAt: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
  }
}

export default function TrendingTest() {
  const data = useLoaderData<typeof loader>();
  return (
    <s-page heading="Trending cron — manual trigger">
      <s-section>
        <s-stack gap="base">
          {data.ok ? (
            <s-banner tone="success" heading="Trending cron ran successfully">
              <s-paragraph>
                Started: {data.startedAt} · Completed: {data.completedAt}
              </s-paragraph>
            </s-banner>
          ) : (
            <s-banner tone="critical" heading="Trending cron threw an error">
              <s-paragraph>
                {'errorMessage' in data ? data.errorMessage : 'Unknown error'}
              </s-paragraph>
            </s-banner>
          )}
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
            {JSON.stringify(data, null, 2)}
          </pre>
        </s-stack>
      </s-section>
    </s-page>
  );
}
