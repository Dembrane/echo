# RFC-0001: A shared agent workflow for this repo

- Status: Proposed
- Owner: patcon
- Last update: 2026-11-19

## Summary

We propose that everyone who works on echo with a coding agent could start from the same
team skill, `dembrane-mode`, and its agent, `dembrane-agent`, kept in this repo.

`dembrane-mode` would sit on top of pstack's `poteto-mode`. `poteto-mode` is one skill that
loads good-practice preferences into the agent and then routes each task to other skills,
playbooks and subagents. Its author is [poteto](https://x.com/poteto):

> grok @bot at @SpaceXSI. react compiler core team, prev cursor, meta, netflix

poteto explains the approach in [a talk](https://www.youtube.com/watch?v=O_zcc6Xl12g)
([slides and text](https://x.com/0x_kaize/status/2121540306822701393)). One of its patterns
is a project-local `/verify-<app>` skill that launches the app and drives it the way a user
would. Our version is `/verify-dembrane`.

The modes nest. `dembrane-mode` overrides `poteto-mode` where the team disagrees, and a
personal mode such as `patcon-mode` overrides `dembrane-mode` where one person disagrees.
You pick the layer when you start a task:

```
/poteto-mode    fix the empty state on the projects page    # pstack only
/dembrane-mode  fix the empty state on the projects page    # plus team rules
/patcon-mode    fix the empty state on the projects page    # plus patcon's rules
/sameer-mode    fix the empty state on the projects page    # plus sameer's rules
/usama-mode     fix the empty state on the projects page    # plus usama's rules
```

`sameer-mode` and `usama-mode` don't exist yet. They show where other personal modes would go.

## Motivation

Each of us has our own agent setup, and it's hard to see or share how anyone else works.
The processes we build are either personal or live outside this repo.

So we may be verifying our work in different ways and to different degrees. It's hard to
know whose workflow is ahead or behind on this project. We can't easily try each other's
workflows. We also can't easily run our local workflows on a shared agent setup, if we decide
to host one. All of this makes it harder to get to an automated software factory, and harder
to build trust in a shared process.

We don't want to write a whole agent workflow ourselves. pstack already has one, and its
author uses it in production working on grokbot, at about
[3,000 PRs a month](https://x.com/0x_kaize/article/2121540306822701393/media/2121314245854085120).
We can reuse it and keep our own layer thin.

## Proposal

### What `poteto-mode` brings

`poteto-mode` is the entry point to the [pstack skills](https://github.com/cursor/plugins/tree/main/pstack/skills).
Its main parts:

- A skill for each engineering principle, such as "Prove It Works" or "Subtract Before You
  Add". The agent reads the ones that apply and names them in its reply.
- The `/verify-<app>` pattern: a project skill that launches the app and drives it to prove
  a change works.
- Playbooks that take different paths for different tasks, such as a bug fix, a feature, a
  refactor or a perf issue.
- Replies that explain what the agent did and which principle shaped each choice.
- Skills for the process around the work: tuning the skills, finding where a run went wrong,
  checking what the agent thinks its goal is, and more.

### Three layers of skills

| Layer | File | Owner |
|---|---|---|
| Base | [`poteto-mode/SKILL.md`](https://github.com/cursor/plugins/tree/35a90942a7f02e1ebbc2443643179815f2147954/harness/pstack/claude-code/skills/poteto-mode) in pstack, pinned | pstack |
| Team | [`.agents/skills/dembrane-mode/SKILL.md`](../../.agents/skills/dembrane-mode/SKILL.md) | The team |
| Personal | [`.agents/skills/<name>-mode/SKILL.md`](../../.agents/skills/patcon-mode/SKILL.md), such as `patcon-mode` | One person |

Each layer reads the layer below it first, and the upper layer wins where they conflict. You
start a session with `/dembrane-mode`, or with your personal mode.

```
~/.claude/plugins/cache/cursor-plugins/pstack/<version>/   # outside the repo
└── skills/
    ├── poteto-mode/           # base layer
    ├── create-verification-skill/
    ├── principle-prove-it-works/
    └── ...                    # about 55 more skills

<repo>/
.agents/                       # tool-neutral home for skills and agents
├── agents/
│   ├── dembrane-agent.md      # subagent for dembrane-mode
│   └── patcon-agent.md        # subagent for patcon-mode
└── skills/
    ├── dembrane-mode/         # team layer
    ├── patcon-mode/           # personal layer
    └── verify-dembrane/       # launch and drive the app
.claude/
├── settings.json              # pins and enables pstack
├── agents -> ../.agents/agents
└── skills -> ../.agents/skills
```

- Subagents get the same layers. Their kickoff makes them read the matching mode's rules
  before they start.
- `.claude/settings.json` pins pstack to one commit, and Claude Code offers to install it.

### Verify in a browser before calling UI work done

`dembrane-mode` has one process rule today. A dashboard or portal change is done only after
the agent proves it on a running copy of the app. Pure logic, or a refactor with no visible
change, needs unit tests only.

The proof comes from `verify-dembrane`. We generated it with pstack's
[`create-verification-skill`](https://github.com/cursor/plugins/tree/35a90942a7f02e1ebbc2443643179815f2147954/harness/pstack/claude-code/skills/create-verification-skill)
setup task, the same process poteto uses. It starts a throwaway copy of the app with its own
database and ports, drives it in a browser from a recipe, and keeps screenshots and database
checks as evidence. The agent drives the browser with
[`agent-browser`](https://github.com/vercel-labs/agent-browser), a CLI that is fast enough to
check a change in a few commands. The recipes for sign-up, onboarding, creating a project and
recording in the portal are proven end to end.

When an agent has verified a flow twice with `agent-browser`, its recipe becomes a Playwright spec under
`dembrane/frontend/e2e/`. The first one is `project-portal.spec.ts`.

## How to try it

1. Check out `feat/agent-proposal` and open Claude Code in the repo root.
2. Accept the prompt to trust the repo and install `pstack`.
3. Run `/dembrane-mode` with a small dashboard or portal task (TODO: pick one).
4. Read the agent's closing summary of what it proved.

## Alternatives considered

### Write our own workflow from scratch

- Pros: we would know every rule, and we would own all of it.
- Cons: a small team would have to relearn practices that large teams have already worked
  out.

### Use pstack's `poteto-mode` on our own workstations only

- Pros: no shared files to agree on.
- Cons: each person's overrides stay private. We still can't see or run each other's
  workflows.

### Sam's agent flow, with the workflow outside this repo

Here the skills and guides live in the `sam-agent` repo, in Notion, or in both. Sam's agent
can still learn to run these skills. The difference is that this proposal keeps
the workflows in the repo, so we can run each other's processes, see how they differ, and
choose which tactics to move up into `dembrane-mode`.

## Costs and risks

- We would learn a new process that other people designed.
- We don't know which agent tools everyone uses. It may be Claude Code for most of us.
- We don't yet know whether this setup works well in tools other than Cursor and Claude Code.
- We may get little value from sharing skills and processes, or people may be happier
  working their own way.

## Open questions

1. Are we interested in this direction, or in one like it?
2. How do we decide what goes into `dembrane-mode`? Proposal: a rule goes in only after
   someone has used it in their personal mode for a while, or when someone else asks for it.
   Teammates pull a rule in. The person who wrote it doesn't push it.
3. Are there existing docs in the repo that `dembrane-mode` should include or link to?
4. Should personal modes live in the repo, or in each person's home folder? Would keeping
   them in this repo get annoying when we want to use them in other projects?
5. CI runs no e2e specs today. Should it run all of them, a subset, or still none?

## To do before sharing

- [ ] Try the steps in "How to try it" in a fresh environment. Check whether running
      `/dembrane-mode` alone prompts the pstack install.
- [ ] Pick the task for step 3: a Linear issue to paste in, or asking the agent to write a
      `verify-dembrane` recipe for a flow that has none.
