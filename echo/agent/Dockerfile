FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
# Copy the lockfile too so the build resolves the SAME, tested dependency
# set (uv sync --frozen). Without the lock at this step, uv resolves fresh
# against pyproject ranges and can pull a newer copilotkit that dropped
# LangGraphAgent — which then gets baked in and served (CMD uses --no-sync).
COPY echo/agent/pyproject.toml echo/agent/uv.lock ./
RUN uv sync --frozen

COPY echo/agent/ .
# Product docs corpus for the agent's read-only knowledge FS
COPY docs/ ./knowledge/docs/

EXPOSE 8001

CMD ["uv", "run", "--no-sync", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
