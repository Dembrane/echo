# Map port: DDW visualizer behavior checklist

Baseline for porting DDW's argument map (`/visualizer`) into Echo, captured on September 15th 2026 from DDW `main` at `439d388`.

How it was captured: DDW dev server on localhost:5190 with Directus pointed at the local stack, a dummy static token, and 53 argument records (35 arguments, 18 claims, 8 conversations) built from the local popcorn session of project `8829ce7a`. Every `/api/vertex` call was answered by an in-page mock with configurable delay and failure. Vectors were synthetic (see the last section). Window sizes 1024x768 and 1440x900.

## Intentional behavior to preserve

### Layout and defaults

- Default panels: Spotlight, Explore, Tree (MST), Clusters (LocalMap) and the Contribute column on; Showcase and Legend off; colour mode None; dark mode off. Panel settings persist in localStorage `visualizer-settings`.
- 12-column grid. Left column (3 cols) stacks Spotlight, Explore, Showcase with equal flex. With both side columns the maps split 3 + 3; with one side column 5 + 4; with none 6 + 6. A single visible map takes all free columns. With no map: "Enable a visualization from the panel settings menu".
- Map headers "Argument Tree (MST)" and "LocalMap", each with a project-scoped "53 arguments" count.
- Empty-state copy: Spotlight "Click a node in the tree or cluster map to spotlight it here."; Explore "Hover over nodes to explore clusters. Hold position for 1.5s to distill the core idea."; Showcase "The random walk will surface nodes here once available."
- Header dots: Spotlight and Showcase #00FFFF, Explore #4169E1, On Record #FFC2FF, Most Recent #1EFFA1.

### MST renderer (ArgumentTree)

- Kruskal MST over cosine distance (53 nodes, 52 edges). Edges #D1D5DB, opacity 0.6, width 1 + 2 x (1 - distance).
- Initial radial layout rooted at the graph centre (minimum eccentricity), angles by subtree size, then d3 forces: link distance (d² + d + 8) x k/12 with k = sqrt(w x h / n), charge -4 (x3 at alpha 0.8 easing to x1, distanceMax 4k), center strength 1, collision 1.25 x radius, MST hop repulsion 0.01. Alpha 0.8, decay 0.003, alphaTarget 0.01 keeps a slow breathing motion.
- Auto-fit every 10 ticks: zooms out only, 750 ms transition, padding 4 x radius, 10% margin, 5% hysteresis. Observed initial scale 0.23 at 1024x768.
- d3 zoom and pan (scale 0.1 to 4); dragging a node pins it and releases on drop.
- Node radius 6; selected node x2 (12); ten newest by createdAt x1.25 (7.5). Observed 1 / 10 / 42 nodes at 12 / 7.5 / 6.
- Light mode node shadow `drop-shadow(0 1px 2px rgba(45,45,44,0.35))`, none in dark mode. Native tooltip with the full statement.
- Hover is "downstream": entering a node highlights it plus its descendants in the tree rooted at the graph centre. Distance = min(depth / 4, 1); outline #4169E1 with stroke width max(1.5, 3 - 1.5 x distance). Observed set sizes from 1 (25 leaves) to 53 (the root).
- Hover publishes to the shared store at once (source `mst-hover`, not preview). Leaving the node clears the store only while the source is still `mst-hover`.
- The MST draws no cursor ring and no timer arc.
- Force Parameters panel (gear, top right): Minimum link length 0 to 50 step 0.5 (8); Medium distances 0 to 10 step 0.1 (1); Dissimilar links 0 to 10 step 0.1 (1); General repulsion force -100 to 0 step 0.5 (-4); Tree repulsion factor 0 to 0.5 step 0.001 (0.01); Reset restores the defaults.

### LocalMap renderer

- kNN with k = min(10, n - 1). Forces: LocalMAP NN attraction (C_Med 10, d_adj 10, strength 0.1), far-pair repulsion over k x 2 x n random pairs (strength 2), charge -10 with distanceMax 0.4 x min(w, h), center strength 0.1, collision 2 x radius. Alpha 0.8, decay 0.004, alphaTarget 0.005. Early-alpha multipliers up to x3.5 charge, x2.5 NN, x3 far pairs.
- Starts from the same MST radial layout. Positions are cached per node, so re-renders keep the layout and a new node appears next to its nearest neighbour (jitter of up to 15 px).
- Red #FF0000 kNN edges for every node: width 1, opacity 0.3, 600 ms fade-in. Edges touching highlighted nodes: opacity 0.6, width 2 - 1.5 x nearest distance. 530 lines for 53 nodes.
- No auto-fit (transform stays identity); zoom 0.1 to 4 survives remounts.
- Cursor ring: dashed #4169E1 circle, radius 50 screen px (divided by zoom), dash 5,5.
- Nodes within 50 px outline at once. The store gets a preview publish (`local-hover`, preview true) immediately, throttled to 50 ms, and a settled publish (preview false) after 0.5 s without movement. Observed at 12 ms and 513 ms, 19 nodes.
- Over empty space a history highlight is kept. Leaving the SVG clears the store only while the source is `local-hover`.
- Timer arc: #4169E1 band between radius 48 and 52 around the cursor, from the settled publish until the title request fires (observed 0.52 s to 2.0 s). Progress is elapsed / 1500 capped at 0.5, so it grows to a half circle.
- Pause / resume button top left (aria-label "Pause physics" / "Resume physics"). Paused, no node moves (0 of 53 in 1.5 s); resume restarts at alpha 0.3.
- LocalMap Forces panel: C_Med 1 to 50 (10), d_adj 1 to 50 (10), Neighbor Attraction 0 to 1 step 0.01 (0.10), Far Pair Repulsion 0 to 10 step 0.1 (2.0), General Repulsion -100 to 0 shown as absolute (10), Collision Radius 0.5x to 5x (2.0x), Charge Distance 0.1 to 1.0 step 0.05 (0.40). Sliders and Reset update forces in place; all 53 node elements and their positions are kept.
- Window resize keeps the LocalMap layout (53 of 53 elements kept from 1024 to 1440 wide).

### Cross-renderer linking

- One shared store: selectedNodeId, highlightedNodeIds, per-node distance, highlightSource (`mst-hover`, `local-hover`, `history`), isPreview, updatedAt.
- Each renderer outlines the union of its own hover set and the store set. LocalMap hover outlines the same 19 nodes in the MST immediately; MST hover outlines its downstream set in the LocalMap.
- Clicking a node in either renderer selects it in both (radius 12 in both) and Spotlight follows.
- A history highlight survives cursor movement over empty space and leaving either renderer; hovering nodes replaces it.

### Selection title flow

- The 1.5 s timer starts when a settled (non-preview) highlight set changes; preview highlights never start it.
- When it fires, summaries are dropped and the set is sent only if at least 3 nodes remain. A 2-node hover sends nothing.
- Explore shows a spinner and "Distilling core idea..." while pending.
- Exactly one request per settled set. Each node is listed as `[argument]` or `[claim, verdict or unverified]`; thinking level low; project name and context prepended when known.
- On success the title is prepended to Explore history, auto-selected (blue card with a collapsed "Contributing Nodes (n)" accordion), and its nodes highlighted with source `history`.
- Re-hovering the set that already has the current title sends no request. Hovering a different set clears the current title and deselects the history card.
- Clicking a history card toggles it. On highlights its nodes at distance 0; off clears the highlight. Neither starts a timer or a request.
- Request timing: MST hover at 1.5 s; LocalMap hover at 2.0 s (0.5 s settle plus 1.5 s).
- History lives in page state only and is lost on reload. An epistemic line (confirmed / contested / unverified counts) is computed for the current title but rendered nowhere.

### Spotlight and Showcase

- On load a random node is selected and shown in Spotlight.
- While Spotlight is visible, a random walk moves the selection to a random MST neighbour every 30 s (measured 30.0 s and 30.1 s). Clicking in the MST reschedules the walk; clicking in the LocalMap does not (see bugs).
- Showcase mirrors the walk node in large type with inline quotes, static chips, a cyan progress bar and "Next change in Ns".
- Spotlight card:
  - Statement, then a collapsible "Quotes (n)", collapsed by default.
  - Valence chip: Positive spring green, Negative salmon, Neutral grey.
  - Fact-check chip: "Opinion" (#9CA3AF) for arguments. For claims one of "Likely true", "Likely false", "Contested", "Unverified", "Checking…".
  - Timestamp like "Aug 5, 1:33 PM".
- Chips toggle the colour mode: valence chip to valence and back to none; fact-check chip to fact-check and back to none. The active chip gets a ring; valence mode adds a one-line explanation.

### Colour modes and legend

- None: every node #9CA3AF.
- Valence: positive #1EFFA1, negative #FF9AA2, neutral #9CA3AF (observed 29 / 13 / 11, matching the data).
- Fact-check:
  - Arguments #9CA3AF.
  - Claims: true #1EFFA1, false #FF9AA2, contested #F4FF81; idle, error and unknown #2D2D2C.
  - Processing #4169E1 with an opacity pulse of 0.5 + 0.5 x |sin(t / 400)|.
- Legend (setting, off by default) at the bottom right of the MST panel, only in valence (3 rows) and fact-check (6 rows) modes.

### Fact-check

- Available only in fact-check colour mode and only for claims ("Fact check this claim"). Arguments show "Arguments express stances or preferences and aren't fact-checked."
- Two passes. First, investigate with Google Search grounding, scoped by project context. Second, classify with a JSON schema into true / false / contested / unknown. Up to 5 unique sources come from grounding chunks. An unparseable classify falls back to unknown, with the analysis as justification.
- Processing: status `processing`, chip "Checking…", pulsing dot, "Checking…" and a Cancel button.
- Done: justification, source links opening in a new tab, "Re-check"; the node fill updates at once.
- Error: the error message in salmon plus "Retry"; the node returns to the unverified fill. Retry completes normally.
- Cancel sets idle at once and aborts the fetch. A response that still arrives does not overwrite idle (observed).
- A new check on the same claim aborts the in-flight one. The buttons are hidden while processing, so a double request is not reachable by clicking.
- Fact-check state persists on the record.
- Settings, fact-check mode only:
  - "Fact check all (n)" counts idle and error claims.
  - "Auto fact-check new claims" fires once per claim per page session, for idle and error claims, only while the colour mode is fact-check.

### Settings menu

- Header gear opens "Panel Settings":
  - Checkboxes: Explore, Showcase, Spotlight, Tree, Clusters, Contribute, Legend.
  - "Color nodes by" radios: None / Valence / Fact-check.
  - Fact-check section.
  - Dark Mode.
  - "Delete Titles (n)" with a two-step confirm.
- Stays open while toggling; closes on a mousedown outside.

### Responsiveness

- 53 nodes run smoothly in both renderers. Both compute all-pairs cosine distances in render (O(n²) over the vector length).

## Observed bugs

1. MST rebuilds from scratch on resize. Repro: load, then resize 1024x768 to 1440x900. All 53 MST node elements were replaced and the simulation restarted from the radial layout. The zoom transform reset to identity and auto-fit never re-engaged (it compares against a stale transform), so the tree overflowed its panel for the rest of the session. Cause: the init effect depends on `dimensions`. Reproduced (LocalMap unaffected).
2. MST goes blank after a Force Parameters change or Reset. Repro: open the MST gear and move Minimum link length from 8 to 12. Result: 0 circles and 0 edges at 0.4 s and 4.4 s; Reset leaves it blank too. The tree came back only after an unrelated re-render (a walk tick). Cause: the init effect recreates the SVG group on slider changes, but the DOM join effect does not depend on the slider values. Reproduced.
3. MST link lengths lose the k/12 scaling after any slider change, including Reset. The slider effect sets the unscaled formula after re-init. Mean edge length fell from 42 to 16.8 graph units. Reproduced.
4. A late title response takes over the current highlight. Repro: title delay 8 s; hover node A (27-node set) until its request fires; move to node B (16-node set) and hold.
   - Two title requests overlap; nothing cancels A's superseded request.
   - When A's response lands, A's title joins history with A's own 27 nodes (it is not attached to B), is auto-selected, and the highlight jumps from B's 16 nodes to A's 27 while the cursor is still on B.
   - The "Distilling core idea..." spinner disappears while B's request is still pending.
   - B's title lands later and takes over again.
   - A pending title also lands and re-highlights after the cursor has left both maps.
   Reproduced.
5. Title errors are silent. Repro: make the title call return 500. The spinner disappears and no message or retry is shown. Reproduced.
6. The random walk moves the selection under the analyst, and the Showcase stalls. `autoAdvance={showSpotlight}` (commit dce4b47) ties the walk to the analyst panel instead of the Showcase, which looks unintentional. Reproduced.
   - With Spotlight shown, the selection changes every 30 s. Repro: select a claim and start a fact-check; before it finished, Spotlight had switched to an unrelated argument.
   - With Spotlight hidden and Showcase shown, the walk stops and Showcase sits at "Next change in 0s" (38 s observed).
7. A LocalMap click does not reschedule the walk. Repro: click a LocalMap node 5.4 s after a walk tick; the next tick still came 30.0 s after the previous one (24.6 s after the click). The MST click path does reschedule (code). Reproduced.
8. Most Recent stays empty ("No arguments captured yet.") on a cold load of `/visualizer` with 53 records. Cause: `useArgumentStore.subscribe(selector, listener)` without `subscribeWithSelector`, so the list never recomputes after IndexedDB hydration or when arguments are added. Reproduced on cold load. After SPA navigation (Home, then back to the visualizer) it listed 12 items, because the store was already hydrated at mount.
9. ExplorePanel crashes the whole page when a history entry references a deleted node. Repro: select a history card (14 nodes), delete one of its nodes from the argument store, open "Contributing Nodes". The label still read "(14)" because `find()` returns undefined and the filter only drops null. Opening the accordion threw "Cannot read properties of undefined (reading 'label')" in NodeListAccordion, and React Router's error boundary replaced the entire visualizer. Reproduced.
10. Auto fact-check fires every pending claim at once (18 investigate plus 18 classify requests, no concurrency limit). A claim that later returns to idle is not retried in the same session. Reproduced.
11. Delete Titles is always disabled: titles are never stored as summary records, so its count stays 0 with 6 titles in history. Reproduced.
12. Cancel after the investigate pass has resolved still sends the classify request (the abort is checked only at the end); state is not overwritten. Observed with a mock that ignores abort.
13. LocalMap has no fit-to-view; at 1024x768 part of the cluster sat outside the panel. The LocalMap Forces panel is wider than the LocalMap column at that width and covers the map. Observed.
14. LocalMap NN and far-pair forces skip any pair where a node's x or y is exactly 0 (`!source.x` style checks). Confirmed in code (`LocalMapGraph.tsx`); not reproduced.
15. The title can silently use only part of a large set. `filterNodesByContextSize` stops at about 6000 estimated tokens (chars / 4), all distances are 0 so it keeps the first nodes in set order, and history still records every node. Confirmed in code; not reproduced (the full 53-node set is about 1300 tokens; every observed request listed the whole set: 13, 27, 16, 18, 19, 14).

## Affordances tied to DDW's standalone or event context

- Contribute card: static QR image plus "n people have contributed so far". Depends on a fixed event portal link baked into an image and a Directus project read with an admin token.
- On Record (Now Recording): live conversations with chunk dots that turn pink when transcribed. Depends on Directus realtime websocket subscriptions with an admin token.
- Most Recent: newest 12 arguments with relative times. Depends on the browser-side argument store (and bug 8).
- Dark mode: adds `dark` to `<html>`, turns `<main>` graphite rgb(45, 45, 44), drops node shadows. Depends on DDW owning the whole document.
- Delete Titles: removes summary records from the IndexedDB argument store. Depends on the legacy summary-record model; nothing creates summaries now.
- Automatic reconciliation (off by default): extracts arguments for project conversations that have none. Depends on browser-side Gemini extraction through the relay plus Directus reads.
- Valence backfill: on mount, classifies every argument missing valence, one call at a time, once per page load. Depends on browser-side Gemini calls and on records written without valence.
- Browser-side extraction on chunk transcribed and conversation finished (power-of-two chunk checkpoints). Depends on Directus realtime and the relay.
- Per-browser IndexedDB store (`ddw-argument-store`): arguments, embeddings and fact-check verdicts live only in that browser.
- Setup gate: a Directus admin static token in localStorage, which also authorises the Vertex relay. The header shows the project name from Directus.

## Not observed / could not verify

- Real embeddings. The local database has no `popcorn_argument_embedding` table (it exists only on the unmerged `popcorn-arguments` branch). The fixture used synthetic 768-dim lexical vectors (hashed word and character n-gram TF-IDF), so cluster shapes differ from production. Counts, timings and state flows do not depend on vector quality.
- Real model output, grounding and latency. Every `/api/vertex` call was mocked.
- Project name and context. Directus reads and the realtime socket failed with the dummy token, so prompts ran without project context, the header name was empty and the Contribute count read 0.
- Pointer pan, wheel zoom and node drag. Described from code, not exercised.
- MST click rescheduling the walk. Code only.
- The Delete Titles confirm step. The button stayed disabled.
- Summary records rendered as nodes. None exist.
- Scale beyond 53 nodes.
- PNG screenshots. The Browser pane tool cannot save images and headless Brave hung in this sandbox, so DOM snapshots were saved as HTML instead (render them with the DDW dev server running on :5190 for fonts and images):
  - `01-default-layout-1440x900.html`
  - `02-settled-title.html`
  - `03-panel-settings-menu.html`
  - `04-settings-menu-factcheck-mode.html`
  - `05-factcheck-colour-mode-legend.html`
  - `06-mst-force-parameters.html`
  - `07-localmap-forces.html`
  - `08-dark-mode.html`
