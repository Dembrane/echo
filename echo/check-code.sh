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

run_fixes_server() {
  cd server
  uv run ruff check --fix .
}

run_fixes_frontend() {
  cd frontend
  pnpm run lint --fix
}

show_help() {
  echo "Usage: $0 [-s] [-f] [-x] [-h]"
  echo "  -s: Run server only"
  echo "  -f: Run frontend only"
  echo "  -x: Run fixes"
  echo "  -h: Show help"
}

parse_args() {
  while getopts "sfxh" opt; do
    case $opt in
      s) run_server_only="true" ;;
      f) run_frontend_only="true" ;;
      x) run_fixes="true" ;;
      h) show_help="true" ;;
    esac
  done
}


# if user passes -s, only run server checks
# if user passes -f, only run frontend checks
# if user passes -s and -f, run both checks
# if user passes neither, run both checks

main() {
  parse_args "$@"

  if [ "$show_help" = "true" ]; then
    show_help
    exit 0
  fi

  if [ "$run_server_only" = "true" ]; then

    if [ "$run_fixes" = "true" ]; then
      run_fixes_server
    else
      server
    fi

  elif [ "$run_frontend_only" = "true" ]; then
    if [ "$run_fixes" = "true" ]; then
      run_fixes_frontend
    else
      frontend
    fi
  else
    if [ "$run_fixes" = "true" ]; then
      run_fixes_server &
      run_fixes_frontend &
      wait
    else
      frontend &
      frontend_pid=$!
      server &
      server_pid=$!
      wait $server_pid
      wait $frontend_pid
    fi
  fi
}

main "$@"