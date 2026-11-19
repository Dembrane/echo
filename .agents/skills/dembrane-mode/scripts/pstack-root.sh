#!/usr/bin/env bash
# Prints the folder of the installed pstack plugin, the base layer under dembrane-mode.
# Its poteto-mode lives at <folder>/skills/poteto-mode/. Warns on stderr when the installed
# commit differs from the one pinned in .claude/settings.json.
set -euo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
PINNED=$(bun -e 'console.log(require(process.argv[1]).extraKnownMarketplaces?.["cursor-plugins"]?.source?.sha ?? "")' "$ROOT/.claude/settings.json")
INSTALLED=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json
read -r DIR SHA < <(bun -e '
  const f = process.argv[1];
  const e = require("fs").existsSync(f) ? require(f).plugins?.["pstack@cursor-plugins"]?.[0] : undefined;
  console.log(e ? `${e.installPath} ${e.gitCommitSha ?? "-"}` : "- -");
' "$INSTALLED")
if [ "$DIR" = - ] || [ ! -f "$DIR/skills/poteto-mode/SKILL.md" ]; then
  echo "pstack is not installed. In Claude Code, trust this repo and accept the plugin prompt from .claude/settings.json, or run: /plugin install pstack@cursor-plugins" >&2
  exit 1
fi
[ "$SHA" = "$PINNED" ] || echo "warning: installed pstack is from $SHA, this repo pins $PINNED (.claude/settings.json)" >&2
echo "$DIR"
