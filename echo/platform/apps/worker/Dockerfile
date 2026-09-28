# syntax=docker/dockerfile:1.7
# Build context: echo/platform.
# One static binary and the files it reads at run time; no node_modules, no source.
FROM oven/bun:1.4 AS build
WORKDIR /src
# The whole workspace, then the lockfile install: a hand-kept list of package manifests
# breaks every time a dependency between packages is added. Bun installs in about a second.
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts
RUN bun build apps/worker/src/main.ts --compile --minify --sourcemap --target=bun-linux-x64 --outfile /out/worker
# A compiled binary has no source tree beside it, so the files it reads are laid out under
# /app/assets as <package>/... (packages/core/src/assets.ts), and the binary
# checks them at boot against apps/worker/src/assets.ts. Popcorn's prompts drive the ticks;
# the chat assistant reads its skill files; the i18n catalogs word the emails.
RUN mkdir -p /assets/popcorn /assets/agentic /assets/i18n \
    && cp -r packages/popcorn/prompts /assets/popcorn/prompts \
    && cp -r packages/agentic/skills /assets/agentic/skills \
    && cp -r packages/i18n/locales /assets/i18n/locales

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/worker /app/worker
COPY --from=build /assets /app/assets
ARG RELEASE=dev
ENV APP_RELEASE=${RELEASE} NODE_ENV=production
USER nonroot
ENTRYPOINT ["/app/worker"]
