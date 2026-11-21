#!/usr/bin/env bash
# Records proof into the run's evidence dir and its proof.md, numbered in the order taken.
#   evidence.sh step <name>          screenshot + page text + URL of the run's browser session
#   evidence.sh query <label> <sql>  read-only query against the run's database, with its output
#   evidence.sh note <text>          a line of your own: what you did, what you expected
set -euo pipefail
. "$(dirname "$0")/lib.sh"
pick_run
PROOF=$EVIDENCE/proof.md
COUNTER=$EVIDENCE/.counter
n=$(( $(cat "$COUNTER" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$COUNTER"
N=$(printf '%02d' "$n")

case "${1:-}" in
  step)
    name=${2:?usage: evidence.sh step <name>}
    url=$(agent-browser --session "$SESSION" get url)
    agent-browser --session "$SESSION" screenshot "$EVIDENCE/$N-$name.png" >/dev/null
    agent-browser --session "$SESSION" snapshot -c > "$EVIDENCE/$N-$name.txt"
    printf '\n## %s %s\n\n- URL: %s\n- Screenshot: [%s](%s), page text: [%s](%s)\n' \
      "$N" "$name" "$url" "$N-$name.png" "$N-$name.png" "$N-$name.txt" "$N-$name.txt" >> "$PROOF"
    echo "$EVIDENCE/$N-$name.png"
    ;;
  query)
    label=${2:?usage: evidence.sh query <label> <sql>}
    sql=${3:?usage: evidence.sh query <label> <sql>}
    out=$(PGOPTIONS='-c default_transaction_read_only=on' psql "$DB_URL" -At -v ON_ERROR_STOP=1 -c "$sql")
    printf '\n## %s %s\n\n```sql\n%s\n```\n\n```\n%s\n```\n' "$N" "$label" "$sql" "$out" >> "$PROOF"
    echo "$out"
    ;;
  note)
    shift
    printf '\n## %s note\n\n%s\n' "$N" "$*" >> "$PROOF"
    ;;
  *)
    echo "usage: evidence.sh step <name> | query <label> <sql> | note <text>" >&2
    exit 2
    ;;
esac
