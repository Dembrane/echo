# syntax=docker/dockerfile:1.7
# Build context: dembrane/platform.
FROM oven/bun:1.4 AS build
WORKDIR /src
# The whole workspace, then the lockfile install: a hand-kept list of package manifests
# breaks every time a dependency between packages is added. Bun installs in about a second.
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts
RUN bun build apps/migrate/src/main.ts --compile --minify --target=bun-linux-x64 --outfile /out/migrate

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/migrate /app/migrate
# The binary reads the migration chain from /app/assets/db/migrations (packages/core/src/
# assets.ts) and checks it at boot, so a job without it fails before touching the database.
COPY --from=build /src/packages/db/migrations /app/assets/db/migrations
USER nonroot
ENTRYPOINT ["/app/migrate"]
