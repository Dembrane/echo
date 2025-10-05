#!/usr/bin/env bash
set -euo pipefail

dramatiq --queues cpu --processes 8 --threads 1 dembrane.tasks