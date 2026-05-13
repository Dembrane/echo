# CLAUDE.md

All project conventions live in @AGENTS.md (the cross-tool standard). Read that file first.

Subdirectory specifics:
- Frontend (React/Vite): @frontend/AGENTS.md
- Server (FastAPI/Dramatiq): @server/AGENTS.md
- GitOps (Terraform/Helm/Argo): @echo-gitops/AGENTS.md

## Claude-Code-specific guidance

These notes apply when Claude Code is the agent (not Cursor / Codex / Aider).

- Use the `Explore` subagent for codebase searches that span more than ~3 queries
- Use the `Plan` subagent before non-trivial multi-file refactors
- Run `/security-review` before merging auth, permissions, or session-handling changes
- `.cursor/rules/` files are Cursor-only — Claude Code does not auto-load them, so the same rules also live in @AGENTS.md
- Memory and skills are configured under `.claude/` and `~/.claude/`; project-level skills currently include `react-best-practices`
