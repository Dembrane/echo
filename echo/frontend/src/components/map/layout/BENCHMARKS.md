# Map layout benchmarks

Measurements, not defaults. The deployment defaults stay at 150 nodes and 450 visible edges until these numbers, measured on target devices, support raising them.

## How they were taken

- September 15th 2026, inside the echo dev container (10 cores, Node 22.22.0), with `--expose-gc`:
  `MAP_BENCH=1 NODE_OPTIONS=--expose-gc pnpm exec vitest run src/components/map/layout/benchmark.run.test.tsx --maxWorkers=1`
- Four other agents were running tests and type checks in the same container at the time, so single rows are noisy. The 150-node distance row, for example, is slower than the 300-node one. Read the trend, and repeat on a quiet machine before deciding anything.
- Fixtures (`benchmark.ts`): synthetic nodes with 768-dimensional vectors in 8 clusters; sparse = 1 relation per node, dense = 8. The edge budget is the default 450, or N - 1 where the tree needs more.
- "Worker" columns run `runLayoutSync`, the same generator the layout worker drives, in Node without a DOM. Browser worker times will differ; the stages and their proportions carry over.
- Renderer columns run in jsdom, which has no layout or paint: mount time includes React, d3 joins and the main-thread geometry prep; "force step" is one `simulation.tick()` (forces only); "draw" is one tick listener (attribute writes). They bound DOM and force work, not browser frame time.

## Layout computation (the worker)

| Nodes | Relations | Distances ms | MST ms | Centre ms | Neighbours ms | Worker total ms | Result clone ms | Working MB | Vectors MB | Heap delta MB | Hop distances ms | Rooted tree ms | Initial positions ms | Edge select MST / LocalMap ms | MST drawn / available | LocalMap drawn / available |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 150 | 150 (sparse) | 310.3 | 11.8 | 5.7 | 33.8 | 362.2 | 24.8 | 0.1 | 0.9 | 3.3 | 55.5 | 0.2 | 12.0 | 0.5 / 8.4 | 299 / 299 | 450 / 1056 |
| 150 | 1200 (dense) | 324.6 | 7.4 | 0.3 | 11.2 | 343.4 | 12.2 | 0.1 | 0.9 | 13.9 | 42.2 | 0.2 | 0.9 | 11.4 / 13.9 | 450 / 1290 | 450 / 2047 |
| 300 | 300 (sparse) | 175.5 | 80.9 | 1.2 | 32.2 | 289.7 | 119.0 | 0.5 | 1.8 | 14.4 | 155.1 | 0.6 | 3.4 | 2.4 / 11.3 | 450 / 596 | 450 / 2303 |
| 300 | 2400 (dense) | 639.7 | 138.3 | 2.4 | 75.1 | 855.6 | 63.7 | 0.5 | 1.8 | 9.1 | 248.0 | 1.9 | 4.8 | 19.3 / 51.2 | 450 / 2633 | 450 / 4340 |
| 500 | 500 (sparse) | 552.3 | 430.2 | 6.7 | 115.7 | 1105.1 | 57.7 | 1.5 | 2.9 | 6.8 | 307.6 | 1.2 | 3.6 | 2.1 / 51.9 | 499 / 999 | 499 / 3993 |
| 500 | 4000 (dense) | 878.4 | 2139.0 | 7.6 | 263.0 | 3288.4 | 95.7 | 1.5 | 2.9 | 7.9 | 803.1 | 6.6 | 37.1 | 184.6 / 81.0 | 499 / 4443 | 499 / 7437 |
| 1000 | 1000 (sparse) | 2323.8 | 882.8 | 26.9 | 153.2 | 3387.0 | 120.2 | 5.8 | 5.9 | 22.9 | 942.2 | 1.1 | 3.5 | 7.4 / 53.3 | 999 / 1999 | 999 / 8413 |
| 1000 | 8000 (dense) | 1945.2 | 1124.1 | 7.5 | 119.8 | 3196.7 | 99.5 | 5.8 | 5.9 | 14.3 | 2343.3 | 23.3 | 14.4 | 96.1 / 181.4 | 999 / 8938 | 999 / 15352 |

Relations do not enter the layout computation, so sparse and dense rows differ there only by noise. Where they differ in the last four columns, it is the edge selection and the counts.

## Renderers in jsdom

| Nodes | Relations | MST mount ms | MST force step ms | MST draw ms | MST lines | LocalMap mount ms | LocalMap force step ms | LocalMap draw ms | LocalMap lines |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 150 | sparse | 1349.7 | 72.9 | 39.0 | 299 | 1087.5 | 35.3 | 37.2 | 450 |
| 150 | dense | 1581.8 | 54.6 | 67.5 | 450 | 410.0 | 12.2 | 45.8 | 450 |
| 300 | sparse | 2706.2 | 151.7 | 248.7 | 450 | 1532.8 | 48.1 | 137.5 | 450 |
| 300 | dense | 2122.0 | 66.8 | 50.2 | 450 | 1094.4 | 19.5 | 42.2 | 450 |
| 500 | sparse | 2597.2 | 180.1 | 86.8 | 499 | 505.9 | 25.2 | 72.6 | 499 |
| 500 | dense | 1405.8 | 88.0 | 84.2 | 499 | 635.3 | 22.5 | 54.9 | 499 |
| 1000 | sparse | 3079.2 | 358.8 | 122.9 | 999 | 1514.1 | 37.3 | 175.2 | 999 |
| 1000 | dense | 2516.4 | 419.7 | 137.9 | 999 | 1222.1 | 49.7 | 103.1 | 999 |

Every row draws at most the edge budget, and the MST always draws all N - 1 tree edges.

## What the numbers point at

1. **Pairwise distances** grow with n² x 768 and dominate the worker at 150 to 300 nodes (0.2 to 0.6 s here). They now run once per node set, off the UI thread, instead of three times on it.
2. **Kruskal's sort** of all n(n-1)/2 pairs is the next cost from 500 nodes (0.4 to 2 s): a comparator sort over up to 500,000 pair indices. An exact Prim's algorithm over the distance matrix is O(n²) without the sort; it keeps exactness but needs the same tie order to match today's tree. A candidate to measure, not yet a change.
3. **Main-thread hop distances** (`mstHopDistances`, a Map of Maps with n² entries, used by the MST repulsion force) cost 0.9 to 2.3 s at 1,000 nodes, and the MST force step itself is O(n²) per tick (0.36 to 0.42 s per tick at 1,000 in jsdom). That is the bottleneck for raising the MST budget far past 300: a typed hop matrix from the worker and a cut-off or Barnes-Hut style repulsion would be the next measurements.
4. **Memory stays small**: the distance matrix and sort order are 5.8 MB at 1,000 nodes; the transferred vectors are the same size. A dense all-pairs matrix is fine at these sizes; revisit above a few thousand nodes.
5. **Edge selection** is cheap (well under 0.2 s even with 8,000 relations) and does not need to move off the main thread.
