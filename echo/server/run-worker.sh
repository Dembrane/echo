#!/usr/bin/env bash

uv run dramatiq-gevent --queues network --processes 1 --threads 10 dembrane.tasks
