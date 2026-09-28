# 0007 Durable workflows with DBOS

**Decision.** Background work runs on DBOS Transact (MIT), a library that checkpoints each
workflow step in our Postgres and resumes a crashed workflow at its first unfinished
step. It replaces pg-boss (plain jobs) and is chosen over Temporal (durable workflows).
Multi-step flows (the conversation pipeline, analysis runs, agent runs) are one function
of steps; plain jobs keep the `@dembrane/queue` interface.

**Why.** The Python pipeline is a five-phase saga repaired by crons, and jobs have no
terminal state (root cause 2 of the rewrite discovery). Temporal solves that but needs a
server (its cloud is a US company holding transcripts in workflow inputs; self-hosting
needs a cluster) and its workers only run on Node. DBOS runs on Bun, compiled into our
single binaries, with nothing new to operate. Proven: a worker killed with `kill -9` in
the middle of a step, another worker resumes it at that step and finishes it without
re-running the steps before (packages/queue/test/recovery.test.ts).

**What we built around it.** Open-source DBOS resumes a workflow only in a process with
the executor id that started it. Each worker instance has a unique id and a heartbeat
(`dbos_executor_heartbeat`); one instance at a time resumes the unfinished workflows of
any instance silent for 60 seconds. DBOS's paid Conductor does this; we do not need it.

**Rules.** A step must be idempotent at its side effects: a crash mid-step runs it again.
Changing the order or number of steps in a workflow bumps `WORKFLOW_VERSION`; in-flight
workflows of the old version are drained or forked before the old code stops. The
migration job installs DBOS's schema with the owner login; workers run with data rights.

**Against.** A younger project than Temporal, and version discipline is on us. If it
fails us, workflow code is plain functions of steps, which is the shape Temporal and
Hatchet also take.
