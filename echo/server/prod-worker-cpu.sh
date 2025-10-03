#!/bin/bash
echo "Starting CPU Workers (Kubernetes mode)"

PROCESSES=${CPU_WORKER_PROCESSES:-2}
THREADS=${CPU_WORKER_THREADS:-4}

echo "Configuration:"
echo "  Processes: $PROCESSES | Threads: $THREADS"
echo "  Capacity per pod: $((PROCESSES * THREADS)) concurrent tasks"
echo "📊 Scale with K8s replicas"

exec dramatiq \
  --queues cpu \
  --processes $PROCESSES \
  --threads $THREADS \
  --watch . \
  --watch-use-polling \
  dembrane.tasks
