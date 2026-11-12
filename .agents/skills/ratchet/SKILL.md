---
name: ratchet
description: Run one ratchet pass for an approved RFC. Usage - /ratchet <rfc id>, e.g. /ratchet 0001
disable-model-invocation: true
---

A ratchet run moves the repo one slice closer to an approved RFC and ends with at most one PR. The RFC is `design/rfcs/<id>-*.md`; the run state is `.agents/ratchet/<id>-*.yml`. A violation is one line of the RFC's Measure output.

## Steps

1. **Load.** Read the RFC and the state file. Done when you can state the RFC's target, its Measure command, and the state's caps. Report and stop when the RFC `status` is not `approved` or the state has `active: false`.

2. **Gate.** List open PRs, then keep those whose title starts with `[ratchet:<id>]`:
   `gh pr list --state open --limit 200 --json number,title,url --jq '.[] | select(.title | startswith("[ratchet:<id>]"))'`
   Done when you hold the count. At or above `max_open_prs`, print the PR URLs and stop without changes.

3. **Branch** `ratchet/<id>-run-<runs+1>` from current `origin/main`.

4. **Measure.** Run the Measure command and set `remaining` to its line count. At 0, set `active: false`, report the target met, and stop.

5. **Slice.** Choose violations from one package or folder whose fix, importers included, stays within `max_files_touched` and `max_changed_lines`. Done when the slice is listed with its file count. A violation that exceeds the caps alone goes to the PR body under "Deferred".

6. **Fix** the slice as the RFC's Rule states. Done when the Measure count has dropped by the slice size, and typecheck, lint, and tests exit 0 for every touched package (take the commands from each package's `package.json`).

7. **Lock in** the cleaned paths as the RFC's Lock-in states. Done when lint fails on a deliberate violation placed in a cleaned path, then passes after you revert it.

8. **Record.** In the state file: `runs` + 1, `remaining`, the slice size appended to `history`, `est_runs_left`.

9. **Open the PR.** Title `[ratchet:<id>] <slice>`. Body holds `ratchet-rfc: <id>`, count before and after, `runs`, `est_runs_left`, and "Deferred" items. Done when `git diff --shortstat` (state file and lock-in entries excluded) is within both caps; shrink the slice and redo from step 5 otherwise.

10. **Reconsider.** When `est_runs_left` has risen for 3 runs in a row, or only Deferred violations remain, open an issue titled `RFC <id>: reconsider target` with the history and the Deferred list. A human edits the RFC.
