#!/usr/bin/env bash

uv run dramatiq --watch ./dembrane --queues cpu --processes 1 --threads 2 dembrane.tasks
