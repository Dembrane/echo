# syntax=docker/dockerfile:1.7
# Build context: echo/platform. One static binary, no node_modules at runtime.
FROM oven/bun:1.4 AS build
WORKDIR /src
# The whole workspace, then the lockfile install: a hand-kept list of package manifests
# breaks every time a dependency between packages is added. Bun installs in about a second.
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts
ARG RELEASE=dev
RUN bun build apps/api/src/main.ts --compile --minify --sourcemap --target=bun-linux-x64 --outfile /out/api

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/api /app/api
ARG RELEASE=dev
ENV APP_RELEASE=${RELEASE} NODE_ENV=production
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/api"]
