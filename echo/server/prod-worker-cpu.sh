#!/bin/bash
echo "Starting CPU Workers (Kubernetes mode)"

PROCESSES=${CPU_WORKER_PROCESSES:-2}
THREADS=${CPU_WORKER_THREADS:-1}

echo "Configuration:"
echo "  Processes: $PROCESSES | Threads: $THREADS"
echo "  Capacity per pod: $((PROCESSES * THREADS)) concurrent tasks"

exec uv run dramatiq \
  --queues cpu \
  --processes "$PROCESSES" \
  --threads "$THREADS" \
  --watch . \
  --watch-use-polling \
  dembrane.tasks
