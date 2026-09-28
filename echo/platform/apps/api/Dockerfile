# syntax=docker/dockerfile:1.7
# Build context: echo/platform, plus a named context "docs" for the repository's docs/
# folder, which sits outside it: docker buildx build --build-context docs=../../docs ...
# One static binary and the files it reads at run time; no node_modules, no source.
FROM oven/bun:1.4 AS build
WORKDIR /src
# The whole workspace, then the lockfile install: a hand-kept list of package manifests
# breaks every time a dependency between packages is added. Bun installs in about a second.
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts
ARG RELEASE=dev
RUN bun build apps/api/src/main.ts --compile --minify --sourcemap --target=bun-linux-x64 --outfile /out/api
# A compiled binary has no source tree beside it, so the files it reads are laid out under
# /app/assets as <package>/... and docs/ (packages/core/src/assets.ts), and the binary
# checks them at boot against apps/api/src/assets.ts. Popcorn's page files serve the decks;
# the docs (markdown only) feed the MCP knowledge tools where no published site applies.
RUN --mount=type=bind,from=docs,target=/docs \
    mkdir -p /assets/popcorn /assets/docs \
    && cp -r packages/popcorn/static /assets/popcorn/static \
    && cd /docs && find . -name '*.md' -exec cp --parents {} /assets/docs/ \;

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/api /app/api
COPY --from=build /assets /app/assets
ARG RELEASE=dev
ENV APP_RELEASE=${RELEASE} NODE_ENV=production
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/api"]
