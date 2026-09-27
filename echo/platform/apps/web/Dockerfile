# syntax=docker/dockerfile:1.7
# Build context: echo/ (the frontend and the platform). The image holds the built static
# files and one compiled server binary, nothing else.
FROM node:24-slim AS frontend
WORKDIR /f
RUN corepack enable && corepack prepare pnpm@10 --activate
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

FROM oven/bun:1.4 AS server
WORKDIR /src
COPY platform/ ./
RUN bun install --frozen-lockfile --production --ignore-scripts
RUN bun build apps/web/src/main.ts --compile --minify --sourcemap --target=bun-linux-x64 --outfile /out/web

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=server /out/web /app/web
COPY --from=frontend /f/dist /app/dist
ARG RELEASE=dev
ENV APP_RELEASE=${RELEASE} WEB_DIST_DIR=/app/dist NODE_ENV=production
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/web"]
