# syntax=docker/dockerfile:1.7
# Build context: echo/platform.
FROM oven/bun:1.4 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/observability/package.json packages/observability/
COPY packages/queue/package.json packages/queue/
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY . .
RUN bun build apps/worker/src/main.ts --compile --minify --sourcemap --target=bun-linux-x64 --outfile /out/worker

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/worker /app/worker
ARG RELEASE=dev
ENV APP_RELEASE=${RELEASE} NODE_ENV=production
USER nonroot
ENTRYPOINT ["/app/worker"]
