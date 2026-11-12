# RFCs

An RFC states a target for the codebase, including targets the code has not reached yet. Each has `status: proposed | approved | superseded` in its frontmatter. Merging a PR that sets `approved` approves it.

Approved RFCs are ratcheted toward by agents, one small PR per run. Run state (caps, run count, history) lives in `.agents/ratchet/`. To pause an RFC, set `active: false` in its state file.

## Run a ratchet pass

- Claude Code: `/ratchet 0001`
- Anywhere else: `Read .agents/skills/ratchet/SKILL.md and follow it for RFC 0001.`

| RFC | Target |
|---|---|
| [0001](0001-file-naming.md) | File names follow one convention per file kind |
| [0002](0002-named-exports.md) | Named exports only |
