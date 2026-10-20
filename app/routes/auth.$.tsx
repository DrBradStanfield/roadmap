import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { refuseAppProxyRequest } from "../lib/local-first-route.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  refuseAppProxyRequest(request);
  await authenticate.admin(request);

  return null;
};
