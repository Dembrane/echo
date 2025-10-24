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

  pnpm i -g @openai/codex

  cd frontend
  pnpm install
}

server_setup() {
  curl -LsSf https://astral.sh/uv/install.sh | sh
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
  export PATH="$HOME/.local/bin:$PATH"
  cd server
  uv sync
}

# hide stdout, only show stderr
frontend_setup &
first=$!

server_setup &
second=$!

wait $first
wait $second

echo "Setup complete"