#!/bin/sh
echo "Starting API server with Gunicorn (Kubernetes mode)"

# Kubernetes-optimized: Fewer workers per pod, scale with replicas
WORKERS=${API_WORKERS:-2}
TIMEOUT=${API_WORKER_TIMEOUT:-120}
MAX_REQUESTS=${API_WORKER_MAX_REQUESTS:-1000}

echo "Configuration:"
echo "  Workers per pod: $WORKERS"
echo "  Timeout: ${TIMEOUT}s"
echo "  Max Requests: $MAX_REQUESTS"
echo "📊 Scale with K8s replicas (not workers per pod)"

# Use custom worker that configures asyncio loop for LightRAG compatibility
# (LightRAG uses asyncio.run() which requires nest_asyncio, incompatible with uvloop)
exec gunicorn dembrane.main:app \
  --workers "$WORKERS" \
  --worker-class dembrane.lightrag_uvicorn_worker.LightRagUvicornWorker \
  --bind 0.0.0.0:8000 \
  --timeout "$TIMEOUT" \
  --graceful-timeout 30 \
  --keep-alive 5 \
  --max-requests "$MAX_REQUESTS" \
  --max-requests-jitter 50 \
  --access-logfile - \
  --error-logfile - \
  --log-level info