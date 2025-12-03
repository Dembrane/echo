#!/usr/bin/env bash
# Dev CPU worker - 1 thread to limit memory usage (FFmpeg can be memory-hungry)

uv run dramatiq --queues cpu --processes 1 --threads 1 dembrane.tasks
