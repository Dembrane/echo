---
status: approved by Jorim on September 20th 2026, being built on branch `results`
branch: to be cut from `recipes` in `~/Dev/echo`
---

One results component for the host who curates for a room and the host who checks the analysis. This version holds the position after two reviews of [[Spec — reusable results component — September 20th 2026]]: Astra on logic (sixteen findings, six spot-checked against the code, all held) and a taste review against the taste-skill rubric. The requirements come from the interview in [[Results component and the deck in React — interview and inventory — September 19th 2026]] plus three decisions Jorim made after the reviews, in section 1.

## 1. Principles, and the three decisions

Inline editing makes changing a finding easy. The audit trail makes it accountable.

1. **The audit trail catches bad behaviour.** The host says what kind of change they made (a typo, clearer words, the meaning). Nobody checks that claim at the time; every revision keeps the before, the after, the kind, the reason, who and when, and co-hosts can read it. Later, a fast cheap classifier (JEV) can flag edits whose kind does not match what changed. The design leaves room for that and does not wait for it.
2. **Public surfaces never show the old version.** The room screen, the public link and the map for viewers show a finding as it reads now. The full history is for people with project access.
3. **What runs is an editorial decision.** Switching a block off, or not running a kind of analysis, needs no reason and leaves no mark anywhere.

## 2. The parts

Composable pieces in `frontend/src/components/results/`, so each page assembles what it needs and the map can take the item alone.

| Part | Does | Used by |
|---|---|---|
| `ResultsList` | Groups by kind, server-sorted, counts. `density: "curate" \| "check"`. | Analysis page, Present results panel |
| `ResultRow` | One skeleton, four fillings. Words editable in place. | `ResultsList` |
| `ResultItem` | Opens on click. A stage card, with a workbench margin for hosts. | List rows, map nodes, room screen, public link |
| `ReasonPrompt` | The one-line step that asks what changed. | Edit, hold back, withdraw |
| `useResultActions` | Edit, hold back, show again, withdraw, restore, restore wording, show to the room. Optimistic updates, undo, conflicts, errors. | All of the above |

Retired into them, in the order of section 12 and never before their replacement exists: `AnalysisResultsList`, the rows in `PresentResultsPanel`, `ResultRowActions`, `EvidenceInspectionDrawer`, the read-only body of `NodeDetailCard`.

## 3. Form

Tokens are the deck's: parchment, paper, graphite, `--ink-soft` for secondary text, `--ink-faint` for resting controls, hairlines between rows, blue as the only accent, the deck's dark tokens in dark mode. No red, orange or green: nothing a host does here is an error. No `Badge`, `Chip`, numbered `Pagination`, toast, or dialog over the item. State is said in words. Group headers are sentence case, weight 500, the count in faint ink ("Popcorn 42"). Rows carry no kind label. Phosphor icons only.

## 4. The list

**Groups.** Popcorn, Tensions, Stakeholders, Map arguments, in the order the presentation shows its blocks. Empty groups are omitted. In Present, a group whose block is off is collapsed and says "not in this presentation".

**One skeleton, four fillings.** A primary line in graphite, a secondary line in soft ink, a small meta line.
- Popcorn: the phrase / nothing (the payload's `question` is a flag, not text; a question simply reads as one).
- Tension: pole A, a blue arrows glyph, pole B / the knot. "To resolve" lives on the item.
- Stakeholder: name / role, the rung as the deck's hairline tag, only when it is not "voiced".
- Argument: statement / "for" or "against" in words. Deduplicated arguments read the same; the server's `EDITABLE_TYPES` gains `deduplicated_argument`.

The primary line clamps at two lines (three in check); the clamp lifts before the caret lands. The meta line has the evidence count on the left ("5 quotes · 3 conversations"; no people count, transcripts are not diarised). In check it adds at most two state words on the right, in this priority: withdrawn, fact-check if `false` or `contested`, edited, combined from 7.

**Needs your eye.** Sorted on the server, before paging, from: new since this host last opened the list, one quote or one conversation only, a fact-check verdict of `false` or `contested`, reworded by someone else since last visit. One phrase per risen row, soft ink, leading the meta line, no icon, only "new" in blue: "new" / "nieuw", "one conversation only" / "uit één gesprek", "one quote only" / "één citaat", "the fact-check disagrees" / "de factcheck zegt iets anders", "Anna reworded this" / "Anna heeft dit herschreven". Risen rows sit above one graphite rule. Order is set when the list opens and holds: a row dealt with loses its phrase, not its place. On a first visit nothing is "new". The list endpoint gains the fields this needs (last authored time and actor, assessment verdict, quote and conversation counts).

**Densities.** `curate` (Present): the skeleton and two controls, hold back and open. `check` (Analysis): adds the state words, a thin filter row (kind, status, search) and withdrawn rows when filtered for.

**Long lists.** A group shows its risen rows plus twenty, then "Show all 140" in place.

## 5. Inline editing and the reason prompt

Click the words; they become editable where they stand, same typography, no layout jump. Enter commits (Cmd/Ctrl+Enter in multi-line fields), Escape restores. Editable fields, enforced by a server allowlist, never by the form alone: popcorn `phrase`; tension `poleA`, `poleB`, `knot`, `toResolve`; stakeholder `name`, `role`, `stake`; argument `statement`. Evidence and quotes cannot be edited by anyone through this endpoint.

On commit the prompt takes over the row's meta line with a 120 ms crossfade, so no row moves. One line: "What did you change?" / "Wat heb je veranderd?" and three text buttons on keys 1 2 3: "A typo" / "Een typfout", "Clearer words, same meaning" / "Duidelijker gezegd, zelfde betekenis", "The meaning" / "De betekenis". For a change of three characters or fewer, focus rests on the first, so Enter, Enter finishes a typo. Only "The meaning" grows the row, by one field (180 ms), labelled above, never as a placeholder: "Why? One sentence, for the people you work with and anyone who checks later." / "Waarom? Eén zin, voor je collega's en voor wie dit later naloopt." Too short reads "A few more words, so someone reading later understands." No number is shown; the server enforces a trimmed minimum and maximum.

Blur never discards. The new words wait in soft ink with the prompt open until the host answers, or Escape restores the old words.

After saving, the meta line reads "Saved as a typo. Undo" / "Opgeslagen als typfout. Ongedaan maken" for ten seconds. Undo is bound to the revision its own edit produced: if someone else has edited since, it conflicts rather than erasing their work. A failed save keeps the host's words in the field: "That did not save. Your words are still here. Try again". A conflict shows both wordings as two lines in the row ("Anna, 2 minutes ago" / "Yours") and the host clicks one.

**One truth, and what live means.** An edit is a new revision on the object. Analysis and the popcorn stage show it at once. Tensions, stakeholders and the map show the snapshot a presentation adopted, which pins revisions, so the spec adds one rule: an adopted snapshot follows **authored** revisions of the objects it already contains (the way withdrawals already override old bindings), while newly **generated** findings still wait for adoption. A fact-check assessment tied to superseded wording is shown as "checked against earlier wording" to hosts and not shown to the room.

## 6. Hold back and withdraw

Two controls, because they say different things. Both live at once; "Publish changes" covers style and structure only.

- **Not in this presentation.** Present only. The prompt: "Why not in this presentation?" / "Waarom niet in deze presentatie?", with three text-button suggestions, the last reason used first ("repeats another finding", "off topic for this room"), or free text. The row dims to 55% in place.
- **Withdraw from the analysis.** In the workbench and the check density, never a one-tap control in curate. Written reason required. Restore is always possible, asks nothing, and is logged.

Restoring an older wording keeps the finding's withdrawn or active state; only restore changes that.

No bulk actions. The general settings routes stop accepting `hidden_items`; the per-finding endpoint is the only way in.

## 7. What the public sees

A finding as it reads now. Where a host changed its words, whatever kind of change they called it, a quiet "edited" / "aangepast" sits beside it, the way WhatsApp marks an edited message: soft ink, the quote modal's attribution size, never animated; on a pop or a map node, a Phosphor pencil glyph at 55% ink, like the deck's translated mark. It does not open: no old wording, no reason, no name. Held-back and withdrawn findings are simply absent, and the presentation carries no count of them. Reasons are written for colleagues and auditors, and the prompt copy says so.

Decided by Jorim on September 20th 2026: the word is "edited" / "aangepast", nothing longer. In the check density the row's state word is the same word.

Decided by Jorim on September 20th 2026: every public presentation shows its evidence. The quotes reach the room whether or not a finding is spotlit, and the presentation's names-on-the-legend setting decides whether the room is told which conversation said them. With it off, no name leaves the server and the room reads "Conversation 1", "Conversation 2", in the order the deck hands its marker colours out. The conversation legend on the map is on by default, now that Conversation is the default colour mode.

**One audience projection.** The bundle, the map payload and the spotlight all pass through one visibility rule: a held-back or withdrawn finding leaves with everything only it referenced, its quotes included. (Today `_without_objects` leaves those quotes in `quotes.json`; that fix is already spun off as its own task and lands first.)

The map payload carries, per visible node, its quotes as plain text grouped by the conversation's opaque palette slot (`detail.evidence: [{conversation, quotes}]`), the same per member of a deduplicated argument (statement and quotes, no member identity), and `conversationNames` slot to name only where the setting is on. It never carries conversation ids, chunk ids, timestamps, dashboard urls, provenance, actor ids or fact-check eligibility. A conversation left with nothing on the map after curation loses its name too.

## 8. The result item

**The stage card** is, pixel for pixel, what a room gets: parchment, the finding in its kind's shape stepping through three type sizes by length and never truncated, at most three quotes of three lines each, unattributed, the evidence count, the quiet mark if any. For an argument with fact-checks on in this presentation, the verdict and its justification.

**The workbench is the stage with a margin.** History (who, when, kind, reason, before and after, "restore this wording"), provenance, the two controls, "open in Analysis" or "show on the map", and **Show to the room** sit beside the card in dashboard type, or below it under 900 px. No tabs. Every sub-step expands inside the item; nothing opens over it.

**Show to the room.** "Show to the room" / "Laat aan de zaal zien": the margin fades, the card stays, and under it "On the room screen now. Close it". The room gets the quote modal's entrance (veil and card, 150 ms) with the stage paused. Spotlight is stored state on the presentation: object, effective revision, a version number. The existing bare `update` event tells screens to refetch it; every read rechecks that the finding is still visible in this presentation and authorises the public link the way the deck bundle does; a stale close conflicts instead of closing someone else's newer spotlight. A spotlight is how a finding takes the whole screen, not how its quotes get out: a public stage card carries its evidence count and, on the map, its quotes under the conversation that spoke them (September 20th 2026).

While the deck is an iframe the React shell draws the card above it. When the deck moves into React this replaces its quote modal.

## 9. Server

- **Revisions** gain nullable `change_kind`: `typo`, `clarity`, `meaning`, `withdraw`, `restore`, `rollback`. Old and generated revisions stay null and read as "not recorded"; nothing is backfilled. Rules per operation, server-side: an edit takes `typo | clarity | meaning`, `meaning` needs a reason; membership takes `withdraw` (reason required) or `restore`; rollback preserves `membershipExcluded`. Actor and time come from the server. The edit endpoint takes a patch of allowlisted fields, not a whole payload.
- **Curation log.** Hold back and show again are per-finding operations against server-current state, appended to a log per presentation (`object_id`, `action`, `reason`, `actor_id`, `at`). The current hidden set is derived from it and mirrored into published and draft settings under the settings lock, advancing the draft revision. Two hosts hiding different findings at once both land. Existing id-only entries are read as held back, reason not recorded. Readers accept both shapes before any writer emits the new one.
- **Snapshots** follow authored revisions of their members (section 5).
- **List endpoint**: server-side attention sort and the extra fields; **last opened** per host per project.
- **Spotlight** state and its audience read.
- **Candidate comparison.** When a later run offers a new reading of an edited finding, hosts get an authenticated read of that candidate to compare. A finding that returns under a new identity after a withdrawal is not connected to the old one; the spec accepts that and the list will show it as new.

All of this needs Sameer's eye: one Directus field, one new collection or JSON log, a settings migration, a change to how snapshots resolve, two public read paths.

## 10. States and motion

Loading: headers first, then skeleton rows in the row skeleton, hairline colour, no spinner. Empty: "No findings yet. They appear after the first analysis." Controls are always visible at faint ink, graphite on hover, focus and under `(hover: none)`, 44 px targets. Focus is the deck's 2 px blue ring; editable words use its `[data-edit]` outline. These never move: row order while the list is open, text on entering edit, the list on load, the public mark, anything in a loop. A spotlit finding never pops like a popcorn. The curve is the deck's `cubic-bezier(0.25, 0.8, 0.3, 1)`. Under reduced motion everything is instant. Keyboard: Tab reaches rows, Enter opens the item, the prompt is a focus-trapped group, Escape backs out one step, slide keys never fire while typing.

## 11. Testing

Unit tests per part. `useResultActions` against a mocked API: optimistic update, undo bound to its revision, two-host undo conflict, failed save keeps the words. Server: allowlist rejects evidence edits; kind and reason rules per operation; rollback keeps membership; curation log under concurrent hides, hide then show then hide keeps all three entries; legacy id-only entries and legacy clients still work during rollout; the old settings route no longer hides; snapshots follow an authored revision and not a generated one; the audience projection drops orphaned quotes; the map payload carries the evidence and no source of it, names it only where the setting says so, and a held-back or withdrawn finding takes its quotes with it; spotlight answers only while the finding is visible, stale close conflicts. One walk through on the local stack, both densities, light and dark, room screen beside it, including fifteen findings held back in a row to feel whether the reason step is bearable minutes before doors open.

## 12. Order of work

1. The audience projection fix (orphaned quotes), already spun off.
2. Server, additive only: nullable `change_kind` accepted but not required, field allowlist, rollback keeps membership, `deduplicated_argument` editable, list endpoint sort and fields, last opened. Existing clients keep working.
3. `ResultItem` (stage and workbench) with history, replacing the drawer in Analysis and the pencil in Present; then the map's node card.
4. `ResultRow`, `ReasonPrompt`, `ResultsList`, `useResultActions`; swap into Present and Analysis; retire the old lists. The server starts requiring `change_kind` once both clients send it.
5. Curation log and live hold back; the old settings route stops accepting `hidden_items`. Snapshots follow authored revisions, shipped together with live editing of tensions, stakeholders and arguments, so the room never shows wording other than the current one. The quiet public mark ships here too.
6. Show to the room, best done with or after the deck's move into React.

## Open questions

- Does a typo fix show to co-hosts in the row ("Anna fixed a typo"), or only in the history? This version says only meaning changes and rewording by others rise.
- Thumbs up and down on a finding stays out of this spec.
- JEV as a good-faith check on edits: what it would flag, to whom, and whether it ever blocks. Worth its own note when the classifier work gets there.
