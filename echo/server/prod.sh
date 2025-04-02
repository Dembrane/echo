#!/bin/sh
echo "Starting server"
# alembic upgrade head
uvicorn dembrane.main:app --host 0.0.0.0 --proxy-headers --loop asyncio