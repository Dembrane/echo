#!/bin/sh

uv run uvicorn dembrane.main:app --host 0.0.0.0 --port 8000 --reload --loop asyncio
