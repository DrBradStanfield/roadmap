import { flatRoutes } from "@react-router/fs-routes";

// Ignore colocated test files + dotfiles so flatRoutes doesn't turn e.g.
// `app.ab-testing.test.ts` into a `/app/ab-testing/test` route (which would bundle
// vitest into the server). The old @remix-run/fs-routes ignored these by default;
// @react-router/fs-routes defaults to `[]`, so we list them explicitly.
export default flatRoutes({
  ignoredRouteFiles: [
    "**/.*",
    "**/*.test.{ts,tsx}",
    "**/*.spec.{ts,tsx}",
  ],
});
