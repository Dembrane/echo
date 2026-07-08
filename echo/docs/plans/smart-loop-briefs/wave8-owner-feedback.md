# Brief: Wave 8 - owner feedback from real echo-next usage (7 items)

The owner walked the setup flow on echo-next and gave verbatim feedback. Fix all
seven. Branch: sameer/smart-loop-feedback-1. Read echo/frontend/AGENTS.md +
echo/agent/skills/interviewing.md + the "## Project setup" prompt section first.

1. SETUP CHAT IS A TOGGLE IN THE WIZARD (frontend). "help me set up this project after
   creation should be a toggle during project creation for better ux, and inform the
   user in advance." In the create wizard: a visible switch like "Set up with the
   assistant after creating" (sentence-case, brand voice; short helper line telling
   them they'll land in a chat). Default ON in agentic environments. OFF -> today's
   /home landing. The existing "Help me figure it out" affordance composes with it
   (it implies the toggle ON + the from-zero seed).

2. NEVER ANNOUNCE AN INTERVIEW (agent skill + prompt). Owner: "interview reads wrong
   and feels like a commitment". Evidence: the assistant said "we can do a quick,
   five-question interview" and dumped THREE numbered questions in one message.
   Rewrite echo/agent/skills/interviewing.md + the setup prompt section: never use the
   word interview or announce question counts; ask ONE question per turn, with 2-4
   concrete options to pick from; plain conversational openers ("What are you hoping
   to learn?"); each turn independently skippable. Update agent tests asserting the
   old wording.

3. REMOVE the composer line "New messages will be answered next." (frontend, wave-7
   addition). Just delete it; the behavior stays.

4. OUTPUT ARTIFACTS (server worker + agent prompt).
   a) Trailing underscore: PERSISTED message on echo-next ends "...Let's start here!_"
      (verified in project_chat_message). Trim trailing orphan cursor-artifacts
      (lone _ or similar trailing junk after terminal punctuation) at the worker
      persistence boundary where host-visible content is already guarded
      (grep _is_host_visible_assistant_content). Test it.
   b) Planning-prose leak: "(I am checking the available project frameworks.)"
      rendered to the host. The #772 guard suppresses planning prose that rides
      alongside tool calls - find why this slipped (prose in the same assistant
      message as, or between, tool activity?) and close the gap. Also prompt: the
      product word is methodologies / "ways of working", never "frameworks"/"tools".

5. DOCS LINK IS NOT THE CLOSER (agent prompt). Owner: "the dembrane project setup docs
   feel like the main [thing]". Rule: documentation mentions are a light aside, never
   the final sentence or the visual CTA of a message; link text is short ("the docs"),
   not a whole clause.

6. SIDEBAR ORDER (frontend): move Library to sit directly below Monitor in
   features/sidebar/views/project/ProjectHomeView.tsx.

7. APPLY IS A MESSAGE + DURABLE CARD STATE (frontend, the big one). Evidence: owner
   applied the suggested goal; on returning to the chat the card offered Apply again,
   and the assistant had said "Let me know once you have applied the goal" (dead-end
   turn). Fix both halves:
   - On Apply success (goal AND canvas cards): automatically send a short user
     message through the normal send path - goal: "I applied the goal." / canvas:
     "I applied the canvas." - so the thread records it durably and the agent takes
     the next turn on its own. Prompt: after proposing, do NOT instruct the host to
     report back - the apply message arrives by itself.
   - Card applied-state must survive remount. Goal card: derive from the existing
     project-goal query (current goal content equals the proposal => applied). Canvas
     card: derive durably too (e.g. the auto-sent apply message in the thread after
     the proposal event, or match an existing canvas by name via the list hook) -
     choose the most honest cheap signal and justify it. CRITICAL: re-clicking Apply
     after remount must never silently create a DUPLICATE canvas.

QA: gates everywhere touched (server whole-tree ruff + focused pytest incl. the new
trim test; agent pytest; frontend tsc/lint/lingui). Playwright locally: wizard toggle
both states; goal apply -> auto message appears -> remount the chat (reload) -> card
shows applied. No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave8-REPORT.md.
