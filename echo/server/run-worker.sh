#!/usr/bin/env bash

uv run dramatiq-gevent --watch ./dembrane --queues network --processes 2 --threads 1 dembrane.tasks
