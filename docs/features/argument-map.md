---
title: Map
description: Map (Beta) reads a project's transcripts, finds the arguments people make and places related arguments close together, with quotes, colours, filters and fact-checks.
audience: host
---

# Map

"Map" (Beta) shows the arguments people make in a project. It reads the project's
transcripts, finds the arguments, and places related arguments close together. Each point on
the map is one argument, and each argument carries the quotes it came from.

"Map" is in the sidebar of every project. It needs no paid plan.

## Generate a map

Press "Generate map". Once a map exists the button reads "Regenerate", and after a failure
"Try again".

- It takes no input. There is no prompt, no question and no selection. It reads every
  conversation that has transcript text.
- A project has one map. There is no list of saved maps and no naming.
- Progress shows as "Waiting to start", "Reading conversations {done} of {total}" and
  "Embedding arguments {done} of {total}".
- If a generation fails, you keep the map you had: "The last generation failed, so this is
  still the previous map."
- A map can also be made without the button. Opening the room screen asks for a map when
  the presentation includes "Map" and none exists, and a live read asks for one too. See
  [Present](./present.md).
- One person can start 10 generations in 10 minutes. After that: "Many maps were started
  just now. Try again in a moment."

Without transcripts the page says: "This project has no conversations with transcripts yet.
Generate a map once conversations have been transcribed."

## What a point is

The header counts "{n} arguments from {m} conversations". Each argument has:

- a statement of one to three sentences;
- one to five quotes, word for word;
- a kind: a claim or an opinion;
- a valence: "Positive", "Negative", "Neutral" or "Not assessed".

A claim is a statement about the world that a web search could find evidence for. Anything
else is a personal stance, a value judgement, a preference, an anecdote or reasoning from
first principles. The map labels it "Opinion".

When several arguments say the same thing, the analysis combines them itself and shows
"combined from {n}". You cannot merge or rename arguments by hand.

## The two views

The same arguments have two views: "Cluster map" and "Argument tree". The toolbar shows
them "One at a time" or "Side by side". The page starts on the cluster map.

Click an argument in either view and it opens in "Spotlight", with "Quotes ({n})" and
"Connections". Each quote links to the page of its conversation.

Rest the cursor for 1.5 seconds on a group of three or more points and the group is saved
as a cluster. A language model gives it a title ("Distilling core idea…"). Saved clusters
also show on the room screen, the public page and the preview on "Present".

The map draws 150 arguments by default. "Map budget" in the settings changes that. For a
large map the page warns: "This map has {count} arguments. Rendering it may be demanding on
your device."

## Colours and filters

"Color nodes by" in the settings colours the points by:

- conversation, which is the default;
- tag;
- valence;
- factual status;
- none.

"Filter" narrows the map by tag ("Show only conversations with any of the ticked tags.") or
by conversation. The page then tells you what is left out: "Showing conversations tagged
{tag}." or "{n} conversations are hidden from the map."

## Fact-checks

Only claims can be checked. For an opinion the map says: "Arguments express stances or
preferences and aren't fact-checked."

- In "Spotlight", press "Fact-check this claim". Later the button reads "Re-check". You can
  cancel a running check.
- The settings menu has "Fact-check all ({n})" and the switch "Auto fact-check new claims".
- A result is "Likely true", "Likely false", "Contested" or "Inconclusive". It comes with a
  written justification and links to its sources.
- The other states are "Unverified", "Checking…" and "Check failed".

A fact-check is the work of a language model. One call searches the web with Google Search,
and a second call classifies what it found. Read the justification and the sources before
you rely on a result.

## Tensions are not on this page

The Map page shows arguments. Tensions show as the "Tensions" outcome on the room screen,
and in "Review results" and "Analysis", each with its two sides and a line "To resolve:".

## Edits made elsewhere change the map

The Map page has no edit controls. You edit a finding under "Review results" on
[Present](./present.md) or under "Results" on [Analysis](./analysis.md), and the map follows.

| Edit | Effect on the map |
|---|---|
| Reword an argument | The map shows the new wording. The earlier wording is kept in the finding's history. |
| "Withdraw" an argument | It leaves the analysis and the map. "Undo withdrawal" brings it back. |
| "Hide from this presentation" | It stays on the Map page. It is left out of that presentation's map for the audience. |

The audience's map never shows the history, and it has no fact-check buttons.

## Who can do what

| Action | Admin | Member | External | Observer |
|---|---|---|---|---|
| See the map | Yes | Yes | Yes | Yes |
| Generate a map, start or cancel a fact-check, save a cluster | Yes | Yes | Yes | No |

Observers see the map without the "Generate map" button. See
[roles & permissions](./roles-and-permissions.md).

## Related

- [Present](./present.md): show the map to a room, with popcorn, "Tensions" and
  "Stakeholders".
- [Analysis](./analysis.md): reword or withdraw an argument, and read its history.
- [Conversations & transcripts](./conversations-and-transcripts.md): the source of every
  quote.
- [Present and Map for hosts](../users/host/present-and-map.md): the walkthrough.
