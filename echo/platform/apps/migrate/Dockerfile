# syntax=docker/dockerfile:1.7
# Build context: echo/platform.
FROM oven/bun:1.4 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY apps/migrate/package.json apps/migrate/
COPY packages/db/package.json packages/db/
COPY packages/queue/package.json packages/queue/
COPY packages/observability/package.json packages/observability/
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY . .
RUN bun build apps/migrate/src/main.ts --compile --minify --target=bun-linux-x64 --outfile /out/migrate

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/migrate /app/migrate
COPY --from=build /src/packages/db/migrations /app/migrations
ENV MIGRATIONS_DIR=/app/migrations
USER nonroot
ENTRYPOINT ["/app/migrate"]
