#!/bin/bash
echo "Starting Network Workers (Kubernetes mode)"

PROCESSES=${NETWORK_WORKER_PROCESSES:-2}
THREADS=${NETWORK_WORKER_THREADS:-20}

echo "Configuration:"
echo "  Processes: $PROCESSES | Threads: $THREADS"
echo "  Capacity per pod: $((PROCESSES * THREADS)) concurrent tasks"
echo "📊 Scale with K8s replicas"

exec dramatiq-gevent \
  --queues network \
  --processes "$PROCESSES" \
  --threads "$THREADS" \
  --watch . \
  --watch-use-polling \
  dembrane.tasks
