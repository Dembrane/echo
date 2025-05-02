#!/bin/sh

uvicorn dembrane.main:app --port 8000 --reload --loop asyncio