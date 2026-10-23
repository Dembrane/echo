#!/bin/bash
# usage: ./run.sh file.js   or   ./run.sh <<'JS' ... JS
curl -s --max-time 300 -X POST --data-binary @"${1:--}" "http://127.0.0.1:${QA_PORT:-7788}/"; echo
