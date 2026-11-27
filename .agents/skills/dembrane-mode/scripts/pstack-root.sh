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
  cat >&2 <<'MSG'
pstack is not installed.
- Interactive claude in a terminal: trust this repo and accept the plugin prompt from .claude/settings.json, or run /plugin install pstack@cursor-plugins.
- Agent SDK hosts (T3 Code and others) have no /plugin. Run these in a shell, then reload plugins:
    claude plugin marketplace add cursor/plugins
    claude plugin install pstack@cursor-plugins
  This installs the marketplace's latest commit, not the pin in .claude/settings.json.
MSG
  exit 1
fi
[ "$SHA" = "$PINNED" ] || echo "note: installed pstack is from $SHA, this repo pins $PINNED (.claude/settings.json). Expected after a 'claude plugin install', safe to continue." >&2
[ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/rules/pstack-models.md" ] || echo "note: no pstack model rule yet, so subagents use pstack's default models. Suggest /pstack:setup-pstack to the user." >&2
# Claude Code keys trust to the main checkout, so trusting it once covers every worktree. Agent
# SDK hosts never show the trust prompt, and until it's accepted, .mcp.json servers stay pending
# and this repo's .claude/settings.json permissions are ignored.
MAIN=$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")
TRUSTED=$(bun -e '
  const f = process.argv[1];
  const p = require("fs").existsSync(f) ? require(f).projects?.[process.argv[2]] : undefined;
  console.log(p?.hasTrustDialogAccepted ? "yes" : "no");
' "${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json" "$MAIN")
[ "$TRUSTED" = yes ] || echo "note: Claude Code doesn't trust $MAIN yet, so .mcp.json servers stay pending and .claude/settings.json permissions are ignored. Run claude there once and accept the trust prompt, or, with the user's OK, set projects[\"$MAIN\"].hasTrustDialogAccepted to true in ~/.claude.json." >&2
echo "$DIR"
