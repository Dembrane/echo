FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY echo/agent/pyproject.toml ./
RUN uv sync --frozen || uv sync

COPY echo/agent/ .
# Product docs corpus for the agent's read-only knowledge FS
COPY docs/ ./knowledge/docs/

EXPOSE 8001

CMD ["uv", "run", "--no-sync", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
