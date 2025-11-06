#!/bin/sh

uv run uvicorn dembrane.main:app --port 8000 --reload --loop asyncio