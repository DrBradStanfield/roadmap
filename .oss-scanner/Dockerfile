# Anthropic OSS Scanner build for Health Roadmap (https://github.com/anthropics/oss-scanner).
# npm workspaces: the server (root, app/), packages/health-core and widget-src.
# Mirrors CI (.github/workflows/ci.yml): Node 22, npm ci, builds, typecheck, tests.
# The scan runs offline, so everything the tests need is installed here.
FROM node:22-bookworm
ENV CI=true

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

RUN npm ci
RUN npm run build:widget && npm run build:pages

# Typecheck as CI does, then the full suite. Failures are logged, not fatal.
RUN (npx tsc --noEmit -p widget-src/tsconfig.json \
      && npx tsc --noEmit -p packages/health-core/tsconfig.json \
      && npm run typecheck:server) || echo "WARNING: typecheck reported errors"
RUN npm run test:all || echo "WARNING: tests reported failures"
CMD ["bash"]
