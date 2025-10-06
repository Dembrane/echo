#!/bin/bash
echo "Starting Network Workers (Kubernetes mode)"

PROCESSES=${NETWORK_WORKER_PROCESSES:-4}
THREADS=${NETWORK_WORKER_THREADS:-2}

echo "Configuration:"
echo "  Processes: $PROCESSES | Threads: $THREADS"
echo "  Capacity per pod: $((PROCESSES * THREADS)) concurrent tasks"
echo "Network-bound tasks can benefit from multiple threads."

exec dramatiq-gevent \
  --queues network \
  --processes "$PROCESSES" \
  --threads "$THREADS" \
  --watch . \
  --watch-use-polling \
  dembrane.tasks
