#!/usr/bin/env bash
# Dev ticks worker: popcorn and canvas ticks on standard dramatiq threads (no gevent)
uv run dramatiq --queues ticks --processes 1 --threads 4 dembrane.tasks
