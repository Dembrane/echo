# Sourced by the scripts that run the old stack. The Python API, Directus and the demo
# scripts are not in this repository any more; they come from a checkout of echo main.
OLD_ECHO_DIR="${OLD_ECHO_DIR:-$HOME/orca/workspaces/echo-parity-main}"
[[ -d "$OLD_ECHO_DIR/echo/server" && -d "$OLD_ECHO_DIR/echo/directus" ]] || {
  echo "no echo main checkout at $OLD_ECHO_DIR (set OLD_ECHO_DIR; see parity/README.md)" >&2
  exit 2
}
export OLD_ECHO_DIR
