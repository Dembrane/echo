# @dembrane/map

The 8 routes of `dembrane.api.v2.bff.map` (project state, the bounded graph, generation,
the live stream, selection titles, fact-checks) and the fact-check workflow. The map
itself is an analysis view (`@dembrane/analysis` mapview.ts): its snapshots, v2 result rows
and the graph payload live there.

## Generation

With the arguments recipe registered, Python's generation request was already a refresh
of that recipe through the executor; the v1 `task_map_generate` actor only ever served
attempts started before that. So map generation is the `analysis.run` workflow of the
arguments recipe (see the analysis README), and a v1 attempt still marked running is
returned first and expired after 20 quiet minutes, as before. v1 results are read and
rendered as before.

## Fact-checks

`map.fact_check` is a DBOS workflow per (check, attempt):

| Step | What | Limit |
|---|---|---|
| `load` | the check row (current attempt still processing), the claim it names, the project context | 1 min |
| `investigate` | the search-grounded call and the classification | 7 min |
| `complete` or `fail` | the verdict, written only while the attempt is current | 1 min |
| `record` | a snapshot revision's verdict as an assessment revision, and the view advanced | 5 min |

The Python worker guarded against a second delivery of the same message with a Redis key
per attempt (`acquire_attempt`); here the workflow is enqueued with `<check id>:<attempt>`
as its dedup key, so a second request for a running attempt joins it. The attempt column
still guards the data: a cancelled or re-forced check bumps the attempt, and a late
verdict of the old attempt writes nothing. A workflow that dies or times out writes
"The fact-check was interrupted. Try again." for its attempt, as `mark_interrupted` did.
`test/recovery.test.ts` kills a worker inside the search call and shows another worker
finishing the same attempt without loading it again.

## Titles

Titles were cached for seven days in Redis, one generation per key across the
deployment. Postgres is the only stateful dependency and a cache table would need a
migration for a convenience, so each API instance keeps its own cache with the same key
and in-process single flight. The cost: a second instance can pay for one more title of
the same selection; it never answers differently for one key.

## Live events

`/events` streams the `map:project:<id>` channel, plus the project's analysis channel
when `runs=1` or once the project has an arguments scope, over Postgres LISTEN/NOTIFY
(`@dembrane/realtime`), with the frames the Python sent.
