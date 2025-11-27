#!/bin/bash
echo "Starting Network Workers (Kubernetes mode)"

PROCESSES=${NETWORK_WORKER_PROCESSES:-3}
THREADS=${NETWORK_WORKER_THREADS:-50}

echo "Configuration:"
echo "  Processes: $PROCESSES | Threads: $THREADS"
echo "  Capacity per pod: $((PROCESSES * THREADS)) concurrent tasks"
echo "Network-bound tasks can benefit from multiple threads."

exec uv run dramatiq-gevent \
  --queues network \
  --processes "$PROCESSES" \
  --threads "$THREADS" \
  dembrane.tasks
