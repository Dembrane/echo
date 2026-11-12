---
status: proposed
---

# 0001 Ratchet agents

This RFC is not ratcheted: it has no Measure command and no state file.

## Rule

An approved RFC that states a measurable target is ratcheted toward by agents, one small PR per run, until the target is met or a human changes it.

- **Approval.** An RFC's frontmatter holds `status: proposed | approved | superseded`. Merging a PR that sets `approved` approves it. Agents execute approved RFCs and write none.
- **Contract.** A ratcheted RFC has these sections: Rule, Target, Measure, Exceptions, Lock-in, Rationale. Measure is a command that prints one line per violation, and Target is that output being empty.
- **Run state.** Operational settings and history live in `.agents/ratchet/<id>-<slug>.yml`, beside no human-facing prose: `active`, `max_open_prs` (default 1), `max_changed_lines`, `max_files_touched`, `runs`, `baseline`, `remaining`, `history`, `est_runs_left`.
- **Run.** A person starts each run by hand with `/ratchet <id>`. The steps are in [`.agents/skills/ratchet/SKILL.md`](../../.agents/skills/ratchet/SKILL.md).
- **Gate.** A run opens a PR only while the open PRs titled `[ratchet:<id>]` number fewer than `max_open_prs`. The PR body carries `ratchet-rfc: <id>`.
- **Size.** A PR stays within `max_changed_lines` and `max_files_touched`. A violation that cannot fit goes under "Deferred" in the PR body.
- **Lock-in.** Each run adds lint or check coverage for the paths it cleaned, so they cannot regress.
- **Pace.** Each PR reports `runs` and `est_runs_left`: remaining violations divided by the median fixed per run over the last five runs.
- **Pause and stop.** Setting `active: false` pauses an RFC. When `est_runs_left` has risen for three runs in a row, or only Deferred violations remain, the run opens an issue titled `RFC <id>: reconsider target`, and a human decides whether to amend the RFC or call it done.

## Target

Not applicable.

## Measure

Not applicable.

## Exceptions

None.

## Lock-in

Not applicable. The skill and its state files are reviewed as ordinary code.

## Rationale

- A written target with a measure lets unattended runs converge on it without a person choosing each change.
- Small capped PRs keep review cheap and merge conflicts rare. The open-PR gate stops a stalled PR from accumulating more behind it.
- Lock-in makes progress one-way; a run estimate and a reconsider step let a goal end short of its first target.
- State stays out of the RFC so that approving a rule and recording progress are separate edits.
- Titles and body markers, not labels, keep the gate lightweight.
