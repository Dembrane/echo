#!/usr/bin/env bash
# Rolls out, lists and tears down PR previews and staging on Cloud Run. Called by
# .github/workflows/platform.yml; runnable by hand with gcloud signed in.
#
#   deploy-env.sh deploy pr-<n> <tag>      a PR preview (echo-pr-<n>-*, database echo_pr_<n>)
#   deploy-env.sh deploy staging <tag>     staging (echo-staging-*)
#   deploy-env.sh make-room <n>            tears down the oldest PR previews until <n> fits,
#                                          printing "removed PR preview <m>" for each
#   deploy-env.sh teardown <n>             removes PR <n>'s services and drops its database
#   deploy-env.sh list                     PR previews, oldest first
#
# Production is not deployed from here: it runs on DigitalOcean Kubernetes through
# Dembrane/echo-gitops (helm/dembrane-web), bumped by platform.yml's 70-deploy-prod.
#
# Each environment lives in its own GCP project (dembrane/infra/<env>). Scaling comes from
# dembrane/infra/<env>.tfvars.json, the file the connection budget check reads. PR previews reuse
# the preview identities, secrets, bucket and Cloud SQL instance.
#
# PR previews are served at dashboard-<n>, portal-<n> and api-<n>.preview.dembrane.com by the
# load balancer in dembrane/infra/preview/lb.tf. The deploy adds the PR's serverless NEGs, backend
# services and host rules; teardown removes them. After its migrations each PR preview's
# migrate job seeds the preview admin (sameer+admin@dembrane.com, password in the
# preview-admin-password secret) and fictional data only: the generated Millbrook sample in
# the org Acme Civic (sample), and the accounts demo for Example Town Council (sample).
#
# HOLD_DATA=1 deploys everything but leaves the data alone: the migrate job is deployed and
# not run, and the worker pool gets 0 instances.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

target=${2:-}
case "$target" in
  staging) ENV=$target ;;
  # A PR preview, or a PR number for make-room and teardown. There is no branch preview.
  pr-* | [0-9]*) ENV=preview ;;
  *) if [ "${1:-}" = list ]; then ENV=preview; else sed -n '2,10p' "$0"; exit 2; fi ;;
esac
case "$ENV" in
  preview) project=dembrane-web-previews number=218237812097 ;;
  staging) project=dembrane-web-staging number=1089877593337 ;;
esac
PROJECT=${PROJECT:-$project}
PROJECT_NUMBER=${PROJECT_NUMBER:-$number}
REGION=${REGION:-europe-west4}
REGISTRY=${REGISTRY:-$REGION-docker.pkg.dev/$PROJECT/echo-$ENV}
TFVARS=${TFVARS:-$here/../../dembrane/infra/$ENV.tfvars.json}
MAX_PR_PREVIEWS=${MAX_PR_PREVIEWS:-3}
SQL=$PROJECT:$REGION:echo-$ENV
BUCKET=$PROJECT-echo-$ENV-uploads
PREVIEW_DOMAIN=${PREVIEW_DOMAIN:-preview.dembrane.com}
PR_LB=${PR_LB:-echo-preview-pr-lb}
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
  local name=$1 tag=$2 prefix db_env="" n=""
  prefix=echo-$name
  if [[ $name == pr-* ]]; then
    n=${name#pr-}
    [[ $n =~ ^[0-9]+$ ]] || { echo "bad PR number: $n" >&2; exit 2; }
    db_env=",DATABASE_NAME=echo_pr_$n"
  fi
  local api web_dash web_portal media public_api
  api=$(url "$prefix-api") web_dash=$(url "$prefix-dashboard") web_portal=$(url "$prefix-portal")
  media=$(url "$prefix-media") public_api=$api
  # staging serves its domains from environments/staging.ts. A PR preview serves its own hostnames behind the load balancer. api-<n> exists because the
  # MCP OAuth issuer and its /.well-known documents live at the API origin's root, which the
  # web servers do not forward. The web servers still forward /api to the API's run.app URL:
  # server to server, and working before DNS points at the load balancer.
  local web_ingress=""
  if [[ $name == pr-* ]]; then
    public_api=$(pr_host api "$n") web_dash=$(pr_host dashboard "$n") web_portal=$(pr_host portal "$n")
    # Dashboard and portal answer only through the load balancer. The API keeps public
    # ingress: the web servers reach it from outside any VPC.
    web_ingress="--ingress internal-and-cloud-load-balancing"
  fi
  local hosts=""
  [ "$ENV" = preview ] && hosts=",API_PUBLIC_URL=$public_api,DASHBOARD_URL=$web_dash,PORTAL_URL=$web_portal,WEB_API_ORIGIN=$api"
  local files="FILES_S3_ENDPOINT=https://storage.googleapis.com,FILES_S3_BUCKET=$BUCKET,STORAGE_S3_ENDPOINT=https://storage.googleapis.com,STORAGE_S3_BUCKET=$BUCKET"
  # A PR preview keeps its objects under pr-<n>/ in the shared bucket, so teardown can delete them.
  if [[ $name == pr-* ]]; then files+=",FILES_S3_PREFIX=pr-$n/,STORAGE_S3_PREFIX=pr-$n/"; fi
  # The dashboard and portal show which PR a preview is, linking to it.
  local web_pr=""
  if [[ $name == pr-* ]]; then web_pr=",WEB_PREVIEW_PR=$n,WEB_PREVIEW_REPO=${GITHUB_REPOSITORY:-Dembrane/echo}"; fi
  local keys
  keys="FILES_S3_ACCESS_KEY_ID=$(secret s3-access-key-id),FILES_S3_SECRET_ACCESS_KEY=$(secret s3-secret-access-key),STORAGE_S3_KEY=$(secret s3-access-key-id),STORAGE_S3_SECRET=$(secret s3-secret-access-key)"
  local filled
  filled=$(filled_secrets)
  # Logs, and Vertex calls, stay in the environment's own project.
  local common="APP_ENV=$ENV,APP_RELEASE=$tag,GCP_PROJECT=$PROJECT,LLM_VERTEX_PROJECT=$PROJECT$hosts$db_env"

  # A PR preview's migrate job also seeds it (apps/migrate/src/preview-seed.ts): it needs the
  # preview's URLs, the bucket the accounts demo writes its PDFs to, and the admin password.
  local seed_env="" seed_secrets=""
  if [[ $name == pr-* ]]; then
    seed_env=",PREVIEW_SEED=1$hosts,$files"
    seed_secrets=",PREVIEW_ADMIN_PASSWORD=preview-admin-password:latest,FILES_S3_ACCESS_KEY_ID=$(secret s3-access-key-id),FILES_S3_SECRET_ACCESS_KEY=$(secret s3-secret-access-key)"
  fi

  local hold=${HOLD_DATA:-0} run_now="--execute-now --wait"
  [ "$hold" = 1 ] && run_now="" && echo "HOLD_DATA: migrate job deployed, not run; worker pool at 0"

  # A PR preview leaves alone every unit whose image digest and settings match what it already
  # runs: a frontend-only push rolls out the dashboard and portal and nothing else, and skips
  # the migrate job. staging rolls out everything, so each revision names its release.
  # SKIP_UNCHANGED=0 forces a full rollout (a rotated secret is only read by a new revision).
  local skip=0
  [[ $name == pr-* ]] && skip=${SKIP_UNCHANGED:-1}
  local state
  state=$(mktemp -d)
  if [ "$skip" = 1 ]; then
    local app
    for app in api worker migrate media web; do
      g artifacts docker images describe "$REGISTRY/$app:$tag" --format 'value(image_summary.digest)' \
        >"$state/digest-$app" &
    done
    wait
  fi

  # Migrations first: a failure stops the rollout before new code takes traffic. On a PR
  # preview's first deploy this also creates its database, and every rollout of the job
  # reseeds it.
  # shellcheck disable=SC2086
  rollout job "$prefix-migrate" migrate --image "$REGISTRY/migrate:$tag" \
    --service-account "$(SA migrate)" --set-cloudsql-instances "$SQL" \
    --set-secrets "MIGRATION_DATABASE_URL=$(secret migration-database-url)$seed_secrets" \
    --set-env-vars "APP_ENV=$ENV,APP_DB_ROLE=echo_app$db_env$seed_env" \
    --task-timeout 600 --max-retries 0 $run_now

  local fail=0 pids=()
  # Media: public ingress, IAM required; only the worker and API identities may invoke it.
  # shellcheck disable=SC2086,SC2046
  rollout service "$prefix-media" media --image "$REGISTRY/media:$tag" \
    --service-account "$(SA media)" --set-env-vars "APP_ENV=$ENV,APP_RELEASE=$tag" \
    $(scale media) --timeout 3600 --ingress all --no-allow-unauthenticated & pids+=($!)
  # shellcheck disable=SC2086,SC2046
  rollout service "$prefix-api" api --image "$REGISTRY/api:$tag" \
    --service-account "$(SA api)" --add-cloudsql-instances "$SQL" \
    --set-secrets "DATABASE_URL=$(secret database-url),AUTH_SECRET=$(secret auth-secret),INVITE_HASH_SECRET=$(secret invite-hash-secret),HTTP_PROXY_SECRET=$(secret proxy-secret),$keys$filled" \
    --set-env-vars "$common,$files,MEDIA_URL=$media" \
    $(scale api) --timeout 3600 --cpu-boost --allow-unauthenticated & pids+=($!)
  local wmin
  wmin=$(jq -r '.services.worker.min' "$TFVARS")
  [ "$hold" = 1 ] && wmin=0
  rollout pool "$prefix-worker" worker --image "$REGISTRY/worker:$tag" \
    --service-account "$(SA worker)" --add-cloudsql-instances "$SQL" \
    --set-secrets "DATABASE_URL=$(secret database-url),$keys$filled" \
    --set-env-vars "$common,$files,MEDIA_URL=$media" \
    --cpu "$(jq -r '.services.worker.cpu' "$TFVARS")" --memory "$(jq -r '.services.worker.memory' "$TFVARS")" \
    --instances "$wmin" & pids+=($!)
  for role in dashboard portal; do
    # shellcheck disable=SC2086,SC2046
    rollout service "$prefix-$role" web --image "$REGISTRY/web:$tag" \
      --service-account "$(SA web)" --set-env-vars "$common,WEB_ROLE=$role$web_pr" \
      --set-secrets "HTTP_PROXY_SECRET=$(secret proxy-secret)" \
      $(scale $role) --allow-unauthenticated $web_ingress & pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || fail=1; done
  [ "$fail" = 0 ] || exit 1
  # Media's invokers; a rollout that left media alone left its policy alone too. One at a
  # time: each binding rewrites the whole policy, and two at once abort each other.
  if [ -e "$state/rolled-$prefix-media" ]; then
    for sa in worker api; do
      g run services add-iam-policy-binding "$prefix-media" --region "$REGION" \
        --member "serviceAccount:$(SA $sa)" --role roles/run.invoker --quiet >/dev/null
    done
  fi

  if [[ $name == pr-* ]]; then route_add "$n"; fi
  local api_rolled=0 worker_rolled=0
  [ -e "$state/rolled-$prefix-api" ] && api_rolled=1
  [ -e "$state/rolled-$prefix-worker" ] && worker_rolled=1
  smoke "$prefix" "$tag" "$hold" "$api_rolled" "$worker_rolled"
  rm -rf "$state"
  echo "api=$public_api dashboard=$web_dash portal=$web_portal"
}

# rollout job|service|pool <name> <app> <gcloud deploy args...>: deploys one unit, with the
# preview-pr label on a PR preview. When skipping is on, the unit is left alone if its label
# deploy-key matches a hash of the image digest and every argument except the commit, and its
# last rollout (or, for the job, its last run) succeeded. Uses deploy()'s n, skip and state.
rollout() {
  local kind=$1 unit=$2 app=$3 key="" now labels=""
  shift 3
  if [ "$skip" = 1 ]; then
    key=$(printf '%s\n' "$kind" "$(cat "$state/digest-$app")" "$@" | sed "s/$tag//g" | sha256sum | cut -c1-16)
    case $kind in
      job) now=$(g run jobs describe "$unit" --region "$REGION" \
        --format 'value(metadata.labels.deploy-key,status.latestCreatedExecution.completionStatus)' 2>/dev/null |
        awk '$2 == "EXECUTION_SUCCEEDED" { print $1 }') || true ;;
      service) now=$(g run services describe "$unit" --region "$REGION" \
        --format 'value(metadata.labels.deploy-key,status.latestReadyRevisionName,status.latestCreatedRevisionName)' 2>/dev/null |
        awk '$2 != "" && $2 == $3 { print $1 }') || true ;;
      pool) now=$(g beta run worker-pools describe "$unit" --region "$REGION" --format json 2>/dev/null |
        jq -r 'select(.status.latestReadyRevisionName == .status.latestCreatedRevisionName) | .metadata.labels["deploy-key"] // empty') || true ;;
    esac
    if [ -n "$now" ] && [ "$now" = "$key" ]; then
      echo "$unit: image and settings unchanged, not redeployed"
      return 0
    fi
  fi
  [[ ${n:-} ]] && labels="preview-pr=$n"
  [ -n "$key" ] && labels+="${labels:+,}deploy-key=$key"
  local flags=(--region "$REGION" --quiet)
  # `gcloud run jobs deploy` takes its labels whole; services and worker pools merge them.
  local label_flag=--update-labels
  [ "$kind" = job ] && label_flag=--labels
  [ -n "$labels" ] && flags+=("$label_flag" "$labels")
  case $kind in
    job) g run jobs deploy "$unit" "${flags[@]}" "$@" ;;
    service) g run deploy "$unit" "${flags[@]}" "$@" ;;
    pool) g beta run worker-pools deploy "$unit" "${flags[@]}" "$@" ;;
  esac
  touch "$state/rolled-$unit"
}

pr_host() { echo "https://$1-$2.$PREVIEW_DOMAIN"; }

# ── PR preview routes ───────────────────────────────────────────────────────
# Each PR gets a serverless NEG and a backend service per role, named like its Cloud Run
# service, and a host rule per role in the shared URL map. NEGs and backend services belong
# to one PR, so concurrent jobs never touch each other's. The URL map is shared: every edit
# reads it, changes only this PR's rules and writes it back with the fingerprint it read.
# The API rejects a stale fingerprint (412), and the edit is retried on a fresh read.
PR_ROLES="api dashboard portal"

compute() {
  # compute <method> <path under the project> [body]; prints the response, fails on non-2xx
  # (3 for a stale fingerprint). A POST passes a body, even empty: Google wants a length.
  local out code
  out=$(curl -sS -X "$1" "https://compute.googleapis.com/compute/v1/projects/$PROJECT/$2" \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" -H 'content-type: application/json' \
    ${3+--data-binary "$3"} -w '\n%{http_code}')
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  printf '%s' "$out"
  [[ $code == 2* ]] || return "$([ "$code" = 412 ] && echo 3 || echo 1)"
}

urlmap_edit() {
  local op=$1 n=$2 map new op_name try rc
  for try in 1 2 3 4 5 6 7 8; do
    map=$(compute GET "global/urlMaps/$PR_LB") || { echo "URL map $PR_LB not readable" >&2; return 1; }
    new=$(jq -c --arg op "$op" --arg n "$n" --arg d "$PREVIEW_DOMAIN" --arg roles "$PR_ROLES" \
      --arg base "https://www.googleapis.com/compute/v1/projects/$PROJECT/global/backendServices" '
      ($roles | split(" ")) as $roles | "pr-\($n)-" as $mine
      | .hostRules = [(.hostRules // [])[] | select(.pathMatcher | startswith($mine) | not)]
      | .pathMatchers = [(.pathMatchers // [])[] | select(.name | startswith($mine) | not)]
      | if $op == "add" then
          .hostRules += [$roles[] | {hosts: ["\(.)-\($n).\($d)"], pathMatcher: "\($mine)\(.)"}]
          | .pathMatchers += [$roles[] | {name: "\($mine)\(.)", defaultService: "\($base)/echo-pr-\($n)-\(.)"}]
        else . end' <<<"$map")
    if [ "$(jq -S '[.hostRules, .pathMatchers]' <<<"$map")" = "$(jq -S '[.hostRules, .pathMatchers]' <<<"$new")" ]; then
      return 0
    fi
    rc=0
    op_name=$(compute PUT "global/urlMaps/$PR_LB" "$new" | jq -r .name) || rc=$?
    if [ "$rc" = 0 ]; then
      # The operation must finish before a backend service it drops can be deleted.
      compute POST "global/operations/$op_name/wait" "" | jq -e '.status == "DONE" and (.error == null)' >/dev/null ||
        { echo "URL map update $op_name did not finish cleanly" >&2; return 1; }
      echo "URL map: PR $n routes: $op done"
      return 0
    fi
    [ "$rc" = 3 ] || { echo "URL map update failed" >&2; return 1; }
    echo "URL map changed underneath (412); retrying" >&2
    sleep $((RANDOM % 5 + try))
  done
  echo "URL map: gave up after $try conflicting updates" >&2
  return 1
}

route_add() {
  local n=$1 role pids=() fail=0
  for role in $PR_ROLES; do
    (
      name=echo-pr-$n-$role
      g compute network-endpoint-groups describe "$name" --region "$REGION" >/dev/null 2>&1 ||
        g compute network-endpoint-groups create "$name" --region "$REGION" \
          --network-endpoint-type serverless --cloud-run-service "$name" --quiet
      g compute backend-services describe "$name" --global >/dev/null 2>&1 ||
        g compute backend-services create "$name" --global \
          --load-balancing-scheme EXTERNAL_MANAGED --quiet
      [ -n "$(g compute backend-services describe "$name" --global --format 'value(backends)')" ] ||
        g compute backend-services add-backend "$name" --global \
          --network-endpoint-group "$name" --network-endpoint-group-region "$REGION" --quiet
    ) & pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || fail=1; done
  [ "$fail" = 0 ] || return 1
  urlmap_edit add "$n"
}

route_remove() {
  local n=$1 role name
  urlmap_edit remove "$n"
  for role in $PR_ROLES; do
    name=echo-pr-$n-$role
    if g compute backend-services describe "$name" --global >/dev/null 2>&1; then
      g compute backend-services delete "$name" --global --quiet
    fi
    if g compute network-endpoint-groups describe "$name" --region "$REGION" >/dev/null 2>&1; then
      g compute network-endpoint-groups delete "$name" --region "$REGION" --quiet
    fi
  done
}

lb_ip() { g compute addresses describe "$PR_LB" --global --format 'value(address)'; }

# smoke <prefix> <tag> [hold] [api rolled out] [worker rolled out]: a unit the rollout left
# alone still serves the release it was deployed with, so only rolled-out units must name <tag>.
smoke() {
  local prefix=$1 tag=$2 api media code release want
  api=$(url "$prefix-api") media=$(url "$prefix-media")
  # A PR preview's dashboard and portal answer only through the load balancer. curl pins
  # the hostname to its address, so this works before DNS; -k because the wildcard
  # certificate is not active until its DNS authorization record exists.
  local via=() n=""
  if [[ $prefix == echo-pr-* ]]; then
    n=${prefix#echo-pr-}
    local ip
    ip=$(lb_ip)
    via=(-k)
    for role in $PR_ROLES; do via+=(--resolve "$role-$n.$PREVIEW_DOMAIN:443:$ip"); done
  fi
  curl -sf "$api/ready" >/dev/null
  release=$(curl -sf "$api/health" | jq -r .release)
  want=$tag
  [ "${4:-1}" = 1 ] || want=$release
  [ "$release" = "$want" ] || { echo "serving $release, expected $want" >&2; exit 1; }
  code=$(curl -s -o /dev/null -w '%{http_code}' "$media/health")
  [ "$code" = 403 ] || { echo "media answered $code without a token, expected 403" >&2; exit 1; }
  for role in dashboard portal; do
    local web
    web=$(url "$prefix-$role")
    [ -n "$n" ] && web=$(pr_host "$role" "$n")
    # A new route can take a minute to reach every load balancer front end; an existing one
    # answers on the first try.
    local tries=1
    [ -n "$n" ] && tries=60
    until curl -sf "${via[@]}" "$web/runtime-config.js" | grep -q "\"role\":\"$role\""; do
      tries=$((tries - 1))
      [ "$tries" -gt 0 ] || { echo "$web/runtime-config.js did not name role $role" >&2; exit 1; }
      sleep 2
    done
    code=$(curl -s "${via[@]}" -o /dev/null -w '%{http_code}' "$web/api/v2/me")
    [ "$code" = 401 ] || { echo "$role /api proxy answered $code, expected 401" >&2; exit 1; }
  done
  if [ -n "$n" ]; then
    release=$(curl -sf "${via[@]}" "$(pr_host api "$n")/health" | jq -r .release)
    [ "$release" = "$want" ] || { echo "api-$n through the load balancer serves $release, expected $want" >&2; exit 1; }
  fi
  [ "${3:-0}" = 1 ] || [ "${5:-1}" = 0 ] || wait_worker "$prefix" "$tag"
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
    sleep 2
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
  # Routes first, so the load balancer stops sending traffic before the services go.
  route_remove "$n"
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
  # The PR's files and audio: everything under its prefix in the shared bucket. Objects older
  # than 30 days go by the bucket's lifecycle rule anyway (dembrane/infra/modules/platform/storage.tf).
  if g storage ls "gs://$BUCKET/pr-$n/" >/dev/null 2>&1; then
    g storage rm --recursive "gs://$BUCKET/pr-$n/" --quiet
  fi
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
    echo "removed PR preview $old"
    count=$((count - 1))
  done
}

case "${1:-}" in
  deploy) deploy "$2" "$3" ;;
  teardown) teardown "$2" ;;
  make-room) make_room "$2" ;;
  list) pr_previews ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
