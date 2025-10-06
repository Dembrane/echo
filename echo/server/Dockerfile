# https://hub.docker.com/_/python
FROM python:3.11 AS base

# Prevents Python from writing pyc files.
ENV PYTHONDONTWRITEBYTECODE=1
# Keeps Python from buffering stdout and stderr to avoid situations where
# the application crashes without emitting any logs due to buffering.
ENV PYTHONUNBUFFERED=1

# Copy the static FFmpeg binaries from the official image
COPY --from=mwader/static-ffmpeg:7.1.1 /ffmpeg /usr/local/bin/ffmpeg
COPY --from=mwader/static-ffmpeg:7.1.1 /ffprobe /usr/local/bin/ffprobe

RUN \
    --mount=type=cache,target=/var/lib/apt/lists \
    --mount=type=cache,target=/var/cache/apt/archives \
    apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates pkg-config zip build-essential && \
    chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe

WORKDIR /code/server

# Install dependencies first (better layer caching)
COPY requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock

# Copy everything else after pip install
# This ensures dependency layer is cached separately from application code
COPY . .

EXPOSE 8000

CMD ["uvicorn", "dembrane.main:app", "--host", "0.0.0.0", "--proxy-headers"]
