#!/bin/sh

# --host 0.0.0.0 lets sibling containers (the agent service) reach the API.
uv run uvicorn dembrane.main:app --host 0.0.0.0 --port 8000 --reload --loop asyncio