import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";
import { cappedRequest, WEBHOOK_BODY_CAP } from "../lib/capped-body.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // The library reads the whole body before its HMAC check (US-09 AC25).
  const capped = await cappedRequest(request, WEBHOOK_BODY_CAP);
  if (!capped) return new Response(null, { status: 413 });
  const { shop, session, topic } = await authenticate.webhook(capped);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await sessionStorage.deleteSession(session.id);
  }

  return new Response();
};
