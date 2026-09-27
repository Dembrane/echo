# syntax=docker/dockerfile:1.7
# Build context: echo/platform. The media service: one compiled binary plus ffmpeg.
FROM oven/bun:1.4 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts
RUN bun build apps/media/src/main.ts --compile --minify --sourcemap --target=bun-linux-x64 --outfile /out/media

# The same static ffmpeg build the Python workers ran (mwader/static-ffmpeg 7.1.1): the
# error texts the pipeline classifies (bad bytes versus retryable) and the codecs
# (libmp3lame, libvorbis) stay identical across the migration. Static binaries need no
# shared libraries, so the runtime stays distroless like the other images: no shell, no
# package manager, only the binaries it runs. Debian slim plus apt's ffmpeg weighs about
# the same (ffmpeg's shared libraries instead of static ones) but brings a shell, apt and
# a different ffmpeg build whose messages and codec defaults would drift from the old one.
FROM mwader/static-ffmpeg:7.1.1 AS ffmpeg

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
COPY --from=build /out/media /app/media
ARG RELEASE=dev
ENV APP_RELEASE=${RELEASE} NODE_ENV=production PATH=/usr/local/bin:/usr/bin:/bin
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/media"]
