# syntax=docker/dockerfile:1.7
# Build context: echo/platform. One static binary, no node_modules at runtime.
FROM oven/bun:1.4 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/observability/package.json packages/observability/
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY . .
ARG RELEASE=dev
RUN bun build apps/api/src/main.ts --compile --minify --sourcemap --target=bun-linux-x64 --outfile /out/api

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/api /app/api
ARG RELEASE=dev
ENV APP_RELEASE=${RELEASE} NODE_ENV=production
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/api"]
