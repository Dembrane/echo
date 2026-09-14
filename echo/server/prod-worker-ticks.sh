#!/bin/sh
# Ticks worker: popcorn and canvas ticks, on standard dramatiq threads.
# Not dramatiq-gevent: see TICK_QUEUE in dembrane/tasks.py for why.
echo "Starting Ticks Workers (Kubernetes mode)"

PROCESSES=${TICKS_WORKER_PROCESSES:-1}
THREADS=${TICKS_WORKER_THREADS:-4}

echo "Configuration:"
echo "  Processes: $PROCESSES | Threads: $THREADS"
echo "  Capacity per pod: $((PROCESSES * THREADS)) concurrent ticks"

exec uv run dramatiq \
  --queues ticks \
  --processes "$PROCESSES" \
  --threads "$THREADS" \
  dembrane.tasks
