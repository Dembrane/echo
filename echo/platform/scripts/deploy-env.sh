#!/usr/bin/env bash
# Rolls out, lists and tears down deployments on Cloud Run. Called by
# .github/workflows/platform.yml; runnable by hand with gcloud signed in.
#
#   deploy-env.sh deploy preview <tag>     the branch preview (echo-preview-*, database echo)
#   deploy-env.sh deploy pr-<n> <tag>      a PR preview (echo-pr-<n>-*, database echo_pr_<n>)
#   deploy-env.sh deploy next <tag>        echo-next (echo-next-*)
#   deploy-env.sh deploy prod <tag>        production (echo-prod-*)
#   deploy-env.sh make-room <n>            tears down the oldest PR previews until <n> fits
#   deploy-env.sh teardown <n>             removes PR <n>'s services and drops its database
#   deploy-env.sh list                     PR previews, oldest first
#
# Each environment lives in its own GCP project (infra/<env>). Scaling comes from
# infra/<env>.tfvars.json, the file the connection budget check reads. PR previews reuse
# the preview identities, secrets, bucket and Cloud SQL instance.
#
# HOLD_DATA=1 deploys everything but leaves the data alone: the migrate job is deployed and
# not run, and the worker pool gets 0 instances. For prod before the cutover (CUTOVER.md),
# whose database stays empty until the restore; W4 runs the job and W6 scales the workers.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

target=${2:-preview}
case "$target" in
  next | prod) ENV=$target ;;
  *) ENV=preview ;;
esac
case "$ENV" in
  preview) project=dembrane-web-previews number=218237812097 ;;
  next) project=dembrane-web-next number=488580804029 ;;
  prod) project=dembrane-web-prod number=740075346439 ;;
esac
PROJECT=${PROJECT:-$project}
PROJECT_NUMBER=${PROJECT_NUMBER:-$number}
REGION=${REGION:-europe-west4}
REGISTRY=${REGISTRY:-$REGION-docker.pkg.dev/$PROJECT/echo-$ENV}
TFVARS=${TFVARS:-$here/../infra/$ENV.tfvars.json}
# Includes the branch preview, which does not take one of these slots.
MAX_PR_PREVIEWS=${MAX_PR_PREVIEWS:-3}
SQL=$PROJECT:$REGION:echo-$ENV
BUCKET=$PROJECT-echo-$ENV-uploads
SA() { echo "echo-$ENV-$1@$PROJECT.iam.gserviceaccount.com"; }
secret() { echo "echo-$ENV-$1:latest"; }
url() { echo "https://$1-$PROJECT_NUMBER.$REGION.run.app"; }
g() { gcloud --project "$PROJECT" "$@"; }

# Secrets filled by hand (Terraform's pending_secrets), as VAR=secret:latest for each one
# that has a value; one without a value is left out, so the key keeps its default (off).
filled_secrets() {
  local name var out=""
  while read -r name var; do
    [ -n "$name" ] || continue
    if [ -n "$(g secrets versions list "$name" --filter state=enabled --limit 1 --format 'value(name)')" ]; then
      out+=",${var^^}=$name:latest"
    fi
  done < <(g secrets list --filter 'labels.env-var:*' --format 'value(name.basename(),labels.env-var)')
  echo "$out"
}

# Scaling flags for one service from the tfvars file.
scale() {
  local s=$1
  jq -r --arg s "$s" '.services[$s] | "--cpu \(.cpu) --memory \(.memory) --concurrency \(.concurrency // 1) --min-instances \(.min) --max-instances \(.max) " + (if .cpu_always then "--no-cpu-throttling" else "--cpu-throttling" end)' "$TFVARS"
}

pr_previews() {
  # PR number and creation time of each PR preview's API service, oldest first.
  g run services list --region "$REGION" --filter 'metadata.labels.preview-pr:*' \
    --format 'value(metadata.labels.preview-pr,metadata.creationTimestamp,metadata.name)' |
    awk '$3 ~ /-api$/ { print $1, $2 }' | sort -k2
}

deploy() {
  local name=$1 tag=$2 prefix db_env="" labels="" job_labels=""
  prefix=echo-$name
  if [[ $name == pr-* ]]; then
    local n=${name#pr-}
    [[ $n =~ ^[0-9]+$ ]] || { echo "bad PR number: $n" >&2; exit 2; }
    db_env=",DATABASE_NAME=echo_pr_$n"
    labels="--update-labels preview-pr=$n"
    job_labels="--labels preview-pr=$n"
  fi
  local api web_dash web_portal media
  api=$(url "$prefix-api") web_dash=$(url "$prefix-dashboard") web_portal=$(url "$prefix-portal")
  media=$(url "$prefix-media")
  # next and prod serve their domains from environments/<env>.ts. Previews serve Cloud Run
  # URLs, which carry the project number, so the deploy sets them.
  local hosts=""
  [ "$ENV" = preview ] && hosts=",API_PUBLIC_URL=$api,DASHBOARD_URL=$web_dash,PORTAL_URL=$web_portal,WEB_API_ORIGIN=$api"
  local files="FILES_S3_ENDPOINT=https://storage.googleapis.com,FILES_S3_BUCKET=$BUCKET,STORAGE_S3_ENDPOINT=https://storage.googleapis.com,STORAGE_S3_BUCKET=$BUCKET"
  local keys
  keys="FILES_S3_ACCESS_KEY_ID=$(secret s3-access-key-id),FILES_S3_SECRET_ACCESS_KEY=$(secret s3-secret-access-key),STORAGE_S3_KEY=$(secret s3-access-key-id),STORAGE_S3_SECRET=$(secret s3-secret-access-key)"
  local filled
  filled=$(filled_secrets)
  # Logs, and Vertex calls, stay in the environment's own project.
  local common="APP_ENV=$ENV,APP_RELEASE=$tag,GCP_PROJECT=$PROJECT,LLM_VERTEX_PROJECT=$PROJECT$hosts$db_env"

  local hold=${HOLD_DATA:-0} run_now="--execute-now --wait"
  [ "$hold" = 1 ] && run_now="" && echo "HOLD_DATA: migrate job deployed, not run; worker pool at 0"
  # Migrations first: a failure stops the rollout before new code takes traffic. On a PR
  # preview's first deploy this also creates its database.
  # shellcheck disable=SC2086
  g run jobs deploy "$prefix-migrate" --region "$REGION" --image "$REGISTRY/migrate:$tag" \
    --service-account "$(SA migrate)" --set-cloudsql-instances "$SQL" \
    --set-secrets "MIGRATION_DATABASE_URL=$(secret migration-database-url)" \
    --set-env-vars "APP_ENV=$ENV,APP_DB_ROLE=echo_app$db_env" \
    --task-timeout 600 --max-retries 0 $job_labels $run_now

  local fail=0 pids=()
  # Media: public ingress, IAM required; only the worker and API identities may invoke it.
  (
    # shellcheck disable=SC2086,SC2046
    g run deploy "$prefix-media" --region "$REGION" --image "$REGISTRY/media:$tag" \
      --service-account "$(SA media)" --set-env-vars "APP_ENV=$ENV,APP_RELEASE=$tag" \
      $(scale media) --timeout 3600 --ingress all --no-allow-unauthenticated $labels --quiet
    for sa in worker api; do
      g run services add-iam-policy-binding "$prefix-media" --region "$REGION" \
        --member "serviceAccount:$(SA $sa)" --role roles/run.invoker --quiet >/dev/null
    done
  ) & pids+=($!)
  # shellcheck disable=SC2086,SC2046
  g run deploy "$prefix-api" --region "$REGION" --image "$REGISTRY/api:$tag" \
    --service-account "$(SA api)" --add-cloudsql-instances "$SQL" \
    --set-secrets "DATABASE_URL=$(secret database-url),AUTH_SECRET=$(secret auth-secret),INVITE_HASH_SECRET=$(secret invite-hash-secret),$keys$filled" \
    --set-env-vars "$common,$files,MEDIA_URL=$media" \
    $(scale api) --timeout 3600 --cpu-boost --allow-unauthenticated $labels --quiet & pids+=($!)
  local wmin
  wmin=$(jq -r '.services.worker.min' "$TFVARS")
  [ "$hold" = 1 ] && wmin=0
  # shellcheck disable=SC2086
  g beta run worker-pools deploy "$prefix-worker" --region "$REGION" --image "$REGISTRY/worker:$tag" \
    --service-account "$(SA worker)" --add-cloudsql-instances "$SQL" \
    --set-secrets "DATABASE_URL=$(secret database-url),$keys$filled" \
    --set-env-vars "$common,$files,MEDIA_URL=$media" \
    --cpu "$(jq -r '.services.worker.cpu' "$TFVARS")" --memory "$(jq -r '.services.worker.memory' "$TFVARS")" \
    --instances "$wmin" $labels --quiet & pids+=($!)
  for role in dashboard portal; do
    # shellcheck disable=SC2086,SC2046
    g run deploy "$prefix-$role" --region "$REGION" --image "$REGISTRY/web:$tag" \
      --service-account "$(SA web)" --set-env-vars "$common,WEB_ROLE=$role" \
      $(scale $role) --allow-unauthenticated $labels --quiet & pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || fail=1; done
  [ "$fail" = 0 ] || exit 1

  smoke "$prefix" "$tag" "$hold"
  echo "api=$api dashboard=$web_dash portal=$web_portal"
}

smoke() {
  local prefix=$1 tag=$2 api media code release
  api=$(url "$prefix-api") media=$(url "$prefix-media")
  curl -sf "$api/ready" >/dev/null
  release=$(curl -sf "$api/health" | jq -r .release)
  [ "$release" = "$tag" ] || { echo "serving $release, expected $tag" >&2; exit 1; }
  code=$(curl -s -o /dev/null -w '%{http_code}' "$media/health")
  [ "$code" = 403 ] || { echo "media answered $code without a token, expected 403" >&2; exit 1; }
  for role in dashboard portal; do
    local web
    web=$(url "$prefix-$role")
    curl -sf "$web/runtime-config.js" | grep -q "\"role\":\"$role\""
    code=$(curl -s -o /dev/null -w '%{http_code}' "$web/api/v2/me")
    [ "$code" = 401 ] || { echo "$role /api proxy answered $code, expected 401" >&2; exit 1; }
  done
  [ "${3:-0}" = 1 ] || wait_worker "$prefix" "$tag"
}

# The worker pool's rollout returns once the revision exists, not once it runs: a worker
# that exits at boot looks deployed. Wait until the API sees a fresh executor heartbeat
# written by this build, and fail the deploy otherwise.
wait_worker() {
  local prefix=$1 tag=$2 api body="" end
  api=$(url "$prefix-api")
  end=$((SECONDS + ${WORKER_WAIT_S:-180}))
  while [ "$SECONDS" -lt "$end" ]; do
    body=$(curl -s -w ' %{http_code}' "$api/ready/worker?release=$tag") || true
    [[ $body == *" 200" ]] && { echo "worker $tag: ${body% *}"; return 0; }
    sleep 5
  done
  echo "worker $tag never wrote a fresh heartbeat within ${WORKER_WAIT_S:-180}s; last answer: $body" >&2
  g logging read "resource.type=\"cloud_run_worker_pool\" AND resource.labels.worker_pool_name=\"$prefix-worker\" AND jsonPayload.signal=\"worker.boot_failed\"" \
    --freshness 15m --limit 1 --format 'value(jsonPayload.message)' >&2 2>/dev/null || true
  exit 1
}

teardown() {
  local n=$1 prefix
  [ "$ENV" = preview ] || { echo "teardown is for PR previews" >&2; exit 2; }
  [[ $n =~ ^[0-9]+$ ]] || { echo "bad PR number: $n" >&2; exit 2; }
  prefix=echo-pr-$n
  echo "tearing down PR $n's preview"
  # The API and worker go first so their connections close before the database is dropped.
  g run services delete "$prefix-api" --region "$REGION" --quiet 2>/dev/null || true
  g beta run worker-pools delete "$prefix-worker" --region "$REGION" --quiet 2>/dev/null || true
  if g run jobs describe "$prefix-migrate" --region "$REGION" >/dev/null 2>&1; then
    g run jobs execute "$prefix-migrate" --region "$REGION" \
      --update-env-vars MIGRATE_DROP_DATABASE=1 --wait
    g run jobs delete "$prefix-migrate" --region "$REGION" --quiet
  fi
  for s in media dashboard portal; do
    g run services delete "$prefix-$s" --region "$REGION" --quiet 2>/dev/null || true
  done
}

make_room() {
  local n=$1 others
  others=$(pr_previews | awk -v n="$n" '$1 != n { print $1 }')
  local count
  count=$(printf '%s\n' "$others" | grep -c . || true)
  # Oldest first: tear down until this PR fits within the limit.
  for old in $others; do
    [ "$count" -lt "$MAX_PR_PREVIEWS" ] && break
    teardown "$old"
    count=$((count - 1))
  done
}

case "${1:-}" in
  deploy) deploy "$2" "$3" ;;
  teardown) teardown "$2" ;;
  make-room) make_room "$2" ;;
  list) pr_previews ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
