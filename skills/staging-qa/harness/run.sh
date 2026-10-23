#!/bin/bash
# usage: ./run.sh file.js   or   ./run.sh <<'JS' ... JS
TOKEN=$(cat "${QA_HOME:-$HOME/.cache/dembrane-qa}/daemon.token")
curl -s --max-time 300 -X POST -H "x-qa-token: $TOKEN" --data-binary @"${1:--}" "http://127.0.0.1:${QA_PORT:-7788}/"; echo
