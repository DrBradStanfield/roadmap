# extensions-dev/ — DEV-APP-ONLY extensions (Phase 5)

Extensions here deploy ONLY with the dev app config:

    shopify app deploy -c dev

`shopify.app.dev.toml` is gitignored (local credential file). It must contain:

    extension_directories = [ "extensions/*", "extensions-dev/*" ]

The prod `shopify.app.toml` keeps the default (`extensions/` only), so a prod
deploy can never ship anything in this directory. The live widget stays
untouched until the Phase 7 cutover.

Build the v2 assets before deploying: `npm run build:shopify-v2`.
