# syntax=docker/dockerfile:1.7
# Build context: echo/platform.
FROM oven/bun:1.4 AS build
WORKDIR /src
# The whole workspace, then the lockfile install: a hand-kept list of package manifests
# breaks every time a dependency between packages is added. Bun installs in about a second.
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts
RUN bun build apps/worker/src/main.ts --compile --minify --sourcemap --target=bun-linux-x64 --outfile /out/worker

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/worker /app/worker
ARG RELEASE=dev
ENV APP_RELEASE=${RELEASE} NODE_ENV=production
USER nonroot
ENTRYPOINT ["/app/worker"]
