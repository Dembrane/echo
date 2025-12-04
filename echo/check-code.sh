#!/bin/sh

frontend() {
  cd frontend
  pnpm run lint
  pnpm run build
}

server() {
  cd server
  uv run mypy .
  uv run ruff check .
}

parse_args() {
  while getopts "sf" opt; do
    case $opt in
      s) run_server_only="true" ;;
      f) run_frontend_only="true" ;;
    esac
  done
}

# if user passes -s, only run server checks
# if user passes -f, only run frontend checks
# if user passes -s and -f, run both checks
# if user passes neither, run both checks

main() {
  parse_args "$@"
  if [ "$run_server_only" = "true" ]; then
    server
  elif [ "$run_frontend_only" = "true" ]; then
    frontend
  else
    frontend &
    frontend_pid=$!
    server &
    server_pid=$!
    wait $server_pid
    wait $frontend_pid
  fi
}

main "$@"