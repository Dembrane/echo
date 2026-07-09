# Brief: Wave 31 — canvas UX: chat prefill deep-link, all versions, one ground color

Start: `git fetch origin && git checkout -b sameer/canvas-ux origin/main`.
No other git write commands. Scope: echo/frontend ONLY.

Three owner asks from the live wall this morning:

## 1. New-chat-with-prefill deep link support

The generated wall's + tab button will link (server wave, separate) to:
`/{lang}/w/{workspaceId}/projects/{projectId}/chats/new?prefill=<urlencoded text>`
Build the frontend side: that route opens the project chat surface with a
NEW chat whose composer is prefilled (NOT auto-sent) with the text, e.g.
"I need a new tab in the 13th Week Retrospective Board canvas: ..." Host
reads, edits, presses send. If a `?prefill=` lands on an existing chat
route, same behavior: composer prefilled, never auto-sent. Keep it safe:
cap length (~500 chars), plain text only (strip markup), and make sure a
reload does not re-prefill after the user cleared it (consume the param).

## 2. See ALL versions

The canvas version/history list currently shows only the latest few
generations. Add "see more" pagination (or "show all") so every generation
is reachable, newest first, with timestamps; keep initial load small
(top ~10, then pages of ~25). Same for config revisions if they share the
list. Owner: "we should be allowed to see all the versions than just the
top n (see more)". Eve also asked to navigate far back ("look at one
version, like 16:03").

## 3. One ground color (screenshot evidence)

The wall renders parchment (#F6F4F1) inside a white dashboard card with a
lighter logo band above — three slightly different backgrounds stacked
(owner: "there is also a diff in bg color"). Make the canvas page read as
ONE surface: the card/frame wrapper and the logo header band adopt the
same parchment ground as the generated wall (match --parchment #F6F4F1;
whitelabel logic untouched), border/rounding kept. Check both the normal
route and fullscreen/present mode (fullscreen should also be parchment,
no white bands).

## QA gates

- cd echo/frontend && npx tsc --noEmit; biome lint; lingui
  extract+compile after string changes; vitest for the prefill param
  consumption logic.
- Report -> echo/docs/plans/smart-loop-briefs/wave31-REPORT.md.
