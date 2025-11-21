#!/bin/sh

frontend() {
  cd frontend
  pnpm run lint
  pnpm run build
}

server() {
  cd server
  mypy .
  ruff check .
}

frontend &
frontend_pid=$!

server &
server_pid=$!

wait $server_pid
wait $frontend_pid

echo -e "\033[1;33m\n==============================================\033[0m"
echo -e "\033[1;33m   IMPORTANT PRE-DEPLOYMENT CHECKLIST:\033[0m"
echo -e "\033[1;33m==============================================\033[0m"
echo -e "\033[1;33m1. Check if all translations are correct\033[0m"
echo -e "\033[1;33m==============================================\n\033[0m"