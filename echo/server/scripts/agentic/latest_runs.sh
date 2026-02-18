#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${SERVER_ROOT}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/.devcontainer/docker-compose.yml"

LIMIT=20
EVENTS_LIMIT=30
PROJECT_ID=""
CHAT_ID=""
RUN_ID=""
JSON_OUTPUT=0

DB_USER="${DB_USER:-dembrane}"
DB_NAME="${DB_NAME:-dembrane}"

usage() {
	cat <<'EOF'
Usage:
  ./scripts/agentic/latest_runs.sh [options]

Options:
  --limit <n>         Number of latest runs to fetch (default: 20)
  --events <n>        Number of latest events per run (default: 30)
  --project-id <id>   Filter by project id
  --chat-id <id>      Filter by project chat id
  --run-id <id>       Filter by a single run id
  --json              Output as JSON
  -h, --help          Show this help
EOF
}

is_positive_int() {
	local value="$1"
	[[ "$value" =~ ^[1-9][0-9]*$ ]]
}

sql_escape() {
	local value="$1"
	value=${value//\'/\'\'}
	printf "%s" "$value"
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--limit)
		LIMIT="${2:-}"
		shift 2
		;;
	--events)
		EVENTS_LIMIT="${2:-}"
		shift 2
		;;
	--project-id)
		PROJECT_ID="${2:-}"
		shift 2
		;;
	--chat-id)
		CHAT_ID="${2:-}"
		shift 2
		;;
	--run-id)
		RUN_ID="${2:-}"
		shift 2
		;;
	--json)
		JSON_OUTPUT=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "Unknown option: $1" >&2
		usage
		exit 1
		;;
	esac
done

if ! is_positive_int "$LIMIT"; then
	echo "--limit must be a positive integer" >&2
	exit 1
fi

if ! is_positive_int "$EVENTS_LIMIT"; then
	echo "--events must be a positive integer" >&2
	exit 1
fi

USE_COMPOSE=0
POSTGRES_CONTAINER_ID=""

POSTGRES_CONTAINER_ID="$(docker ps --filter "name=postgres" --format '{{.ID}}' | head -n 1 || true)"
if [[ -z "$POSTGRES_CONTAINER_ID" ]]; then
	if command -v docker >/dev/null 2>&1 && docker compose -f "$COMPOSE_FILE" ps postgres >/dev/null 2>&1; then
		USE_COMPOSE=1
	else
		echo "Could not find postgres container. Start the stack first." >&2
		exit 1
	fi
fi

run_psql() {
	local sql="$1"
	shift || true
	if [[ "$USE_COMPOSE" -eq 1 ]]; then
		docker compose -f "$COMPOSE_FILE" exec -T postgres \
			psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@" -c "$sql"
	else
		docker exec -i "$POSTGRES_CONTAINER_ID" \
			psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@" -c "$sql"
	fi
}

conditions=()
if [[ -n "$PROJECT_ID" ]]; then
	conditions+=("project_id = '$(sql_escape "$PROJECT_ID")'")
fi
if [[ -n "$CHAT_ID" ]]; then
	conditions+=("project_chat_id = '$(sql_escape "$CHAT_ID")'")
fi
if [[ -n "$RUN_ID" ]]; then
	conditions+=("id = '$(sql_escape "$RUN_ID")'")
fi

WHERE_CLAUSE="TRUE"
if [[ ${#conditions[@]} -gt 0 ]]; then
	WHERE_CLAUSE="${conditions[0]}"
	for condition in "${conditions[@]:1}"; do
		WHERE_CLAUSE="${WHERE_CLAUSE} AND ${condition}"
	done
fi

SELECTED_RUNS_CTE="
WITH selected_runs AS (
	SELECT
		id,
		project_id,
		project_chat_id,
		directus_user_id,
		status,
		last_event_seq,
		latest_output,
		latest_error,
		latest_error_code,
		started_at,
		completed_at,
		created_at,
		updated_at
	FROM project_agentic_run
	WHERE ${WHERE_CLAUSE}
	ORDER BY updated_at DESC
	LIMIT ${LIMIT}
)
"

if [[ "$JSON_OUTPUT" -eq 1 ]]; then
	JSON_SQL="${SELECTED_RUNS_CTE}
SELECT COALESCE(json_agg(row_to_json(run_row) ORDER BY run_row.updated_at DESC), '[]'::json)
FROM (
	SELECT
		r.id,
		r.project_id,
		r.project_chat_id,
		r.directus_user_id,
		r.status,
		r.last_event_seq,
		r.latest_output,
		r.latest_error,
		r.latest_error_code,
		r.started_at,
		r.completed_at,
		r.created_at,
		r.updated_at,
		COALESCE(
			(
				SELECT json_agg(
					json_build_object(
						'seq', e.seq,
						'event_type', e.event_type,
						'timestamp', e.timestamp,
						'payload', e.payload
					)
					ORDER BY e.seq DESC
				)
				FROM (
					SELECT seq, event_type, timestamp, payload
					FROM project_agentic_run_event
					WHERE project_agentic_run_id = r.id
					ORDER BY seq DESC
					LIMIT ${EVENTS_LIMIT}
				) e
			),
			'[]'::json
		) AS events
	FROM selected_runs r
) run_row;
"
	run_psql "$JSON_SQL" -At
	exit 0
fi

RUNS_SQL="${SELECTED_RUNS_CTE}
SELECT
	id,
	COALESCE(project_id::text, '<null>'),
	COALESCE(project_chat_id::text, '<null>'),
	COALESCE(directus_user_id, '<null>'),
	COALESCE(status, '<null>'),
	COALESCE(last_event_seq::text, '0'),
	COALESCE(started_at::text, '<null>'),
	COALESCE(completed_at::text, '<null>'),
	COALESCE(updated_at::text, '<null>'),
	LEFT(COALESCE(latest_output, '<null>'), 140),
	LEFT(COALESCE(latest_error, '<null>'), 140),
	COALESCE(latest_error_code, '<null>')
FROM selected_runs
ORDER BY updated_at DESC;
"

RUNS_OUTPUT="$(run_psql "$RUNS_SQL" -At -F $'\t')"
if [[ -z "$RUNS_OUTPUT" ]]; then
	echo "No agentic runs found."
	exit 0
fi

echo "Latest agentic runs (limit=${LIMIT}, events_per_run=${EVENTS_LIMIT})"
echo
while IFS=$'\t' read -r run_id project_id project_chat_id directus_user_id status last_event_seq started_at completed_at updated_at latest_output latest_error latest_error_code; do
	[[ -z "$run_id" ]] && continue
	echo "Run: ${run_id}"
	echo "  project_id: ${project_id/<null>/<none>}"
	echo "  chat_id: ${project_chat_id/<null>/<none>}"
	echo "  user_id: ${directus_user_id/<null>/<none>}"
	echo "  status: ${status/<null>/<none>}"
	echo "  last_event_seq: ${last_event_seq}"
	echo "  started_at: ${started_at/<null>/<none>}"
	echo "  completed_at: ${completed_at/<null>/<none>}"
	echo "  updated_at: ${updated_at/<null>/<none>}"
	if [[ "$latest_output" != "<null>" ]]; then
		echo "  latest_output: ${latest_output}"
	fi
	if [[ "$latest_error" != "<null>" ]]; then
		echo "  latest_error: ${latest_error}"
	fi
	if [[ "$latest_error_code" != "<null>" ]]; then
		echo "  latest_error_code: ${latest_error_code}"
	fi

	EVENTS_SQL="
SELECT
	seq,
	event_type,
	COALESCE(timestamp::text, ''),
	LEFT(REPLACE(COALESCE(payload::text, ''), E'\n', ' '), 240)
FROM project_agentic_run_event
WHERE project_agentic_run_id = '$(sql_escape "$run_id")'
ORDER BY seq DESC
LIMIT ${EVENTS_LIMIT};
"
	EVENTS_OUTPUT="$(run_psql "$EVENTS_SQL" -At -F $'\t')"
	if [[ -z "$EVENTS_OUTPUT" ]]; then
		echo "  events: <none>"
		echo
		continue
	fi

	echo "  events:"
	while IFS=$'\t' read -r seq event_type timestamp payload; do
		[[ -z "$seq" ]] && continue
		echo "    [${seq}] ${event_type} @ ${timestamp:-<none>}"
		if [[ -n "$payload" ]]; then
			echo "      payload: ${payload}"
		fi
	done <<< "$EVENTS_OUTPUT"
	echo
done <<< "$RUNS_OUTPUT"
