#!/bin/bash

frontend_setup () {
  curl -fsSL https://fnm.vercel.app/install | bash
  echo 'eval "$(fnm env --use-on-cd)"' >> ~/.bashrc
  FNM_PATH="/root/.local/share/fnm"
  if [ -d "$FNM_PATH" ]; then
    export PATH="$FNM_PATH:$PATH"
    eval "`fnm env`"
  fi  
  fnm install 22
  npm i -g pnpm
  pnpm config set store-dir /home/node/.local/share/pnpm/store

  pnpm install -g azure-functions-core-tools@4

  cd frontend
  pnpm install
}

server_setup() {
  curl -sSf https://rye.astral.sh/get | RYE_INSTALL_OPTION="--yes" bash
  echo 'source "$HOME/.rye/env"' >> ~/.bashrc
  . $HOME/.rye/env
  cd server
  rye sync
  pip install mypy
}

# hide stdout, only show stderr
frontend_setup &
first=$!

server_setup &
second=$!

wait $first
wait $second

echo "Setup complete"