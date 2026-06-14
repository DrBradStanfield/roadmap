import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

// This route renders OUTSIDE the embedded Shopify admin (the merchant isn't
// authenticated yet), so App Bridge — and therefore the Polaris web components
// (`s-*`) — is unavailable here. Rather than re-introduce the Polaris React
// dependency for a single standalone form, this uses plain semantic HTML with
// inline styles. It's a minimal shop-domain entry form.
export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <main style={{ maxWidth: 400, margin: "64px auto", padding: "0 16px", fontFamily: "Inter, system-ui, sans-serif" }}>
      <Form method="post">
        <div style={{ border: "1px solid #e1e3e5", borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Log in</h2>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 14 }}>Shop domain</span>
            <input
              type="text"
              name="shop"
              value={shop}
              onChange={(e) => setShop(e.currentTarget.value)}
              autoComplete="on"
              style={{
                padding: "8px 12px",
                fontSize: 14,
                borderRadius: 8,
                border: `1px solid ${errors.shop ? "#d72c0d" : "#8a8a8a"}`,
              }}
            />
            <span style={{ fontSize: 12, color: errors.shop ? "#d72c0d" : "#6d7175" }}>
              {errors.shop || "example.myshopify.com"}
            </span>
          </label>
          <button
            type="submit"
            style={{
              padding: "8px 16px",
              fontSize: 14,
              fontWeight: 500,
              color: "#fff",
              background: "#303030",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              alignSelf: "flex-start",
            }}
          >
            Log in
          </button>
        </div>
      </Form>
    </main>
  );
}
