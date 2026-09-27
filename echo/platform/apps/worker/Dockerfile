# syntax=docker/dockerfile:1.7
# Build context: echo/platform, plus a named context "docs" for the repository's docs/
# folder, which sits outside it: docker buildx build --build-context docs=../../docs ...
FROM oven/bun:1.4 AS build
WORKDIR /src
# The whole workspace, then the lockfile install: a hand-kept list of package manifests
# breaks every time a dependency between packages is added. Bun installs in about a second.
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts
RUN bun build apps/worker/src/main.ts --compile --minify --sourcemap --target=bun-linux-x64 --outfile /out/worker

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/worker /app/worker
# The chat assistant reads the product docs and its skill files at run time. A compiled
# binary has no source tree to find them relative to, so both paths are set explicitly.
COPY --from=docs . /app/docs
COPY --from=build /src/packages/agentic/skills /app/skills
ARG RELEASE=dev
ENV APP_RELEASE=${RELEASE} NODE_ENV=production \
    AGENTIC_DOCS_DIR=/app/docs AGENTIC_SKILLS_DIR=/app/skills
USER nonroot
ENTRYPOINT ["/app/worker"]
