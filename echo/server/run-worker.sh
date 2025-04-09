#!/bin/bash

# Function to launch a Celery worker
launch_worker() {
  local worker_name=$1
  local queue_name=$2

  echo "Launching Celery worker: $worker_name on queue: $queue_name"
  if [ "$queue_name" == "cpu" ]; then
    celery -A dembrane.tasks worker -E -l INFO -n $worker_name -Q $queue_name &
  else
    celery -A dembrane.tasks worker -E -l INFO -n $worker_name -Q $queue_name &
  fi
  # Store the PID of the worker
  WORKER_PIDS+=($!)
}

# Trap SIGINT and handle it
trap 'terminate_processes' SIGINT

# Function to terminate all background processes
terminate_processes() {
  echo "Terminating all background processes..."
  for pid in "${WORKER_PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null
  done
  kill -TERM "$FLOWER_PID" 2>/dev/null
  exit 0
}

# Array to store PIDs of launched workers
WORKER_PIDS=()

# Launch the workers
launch_worker "worker.normal" "normal"
launch_worker "worker.cpu" "cpu"

# Launch Flower
echo "Launching Flower"
export FLOWER_UNAUTHENTICATED_API=True
celery -A dembrane.tasks flower &
FLOWER_PID=$!

# Wait for all background jobs to finish
wait