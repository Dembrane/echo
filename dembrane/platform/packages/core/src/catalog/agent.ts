import type { Codes } from "./types";

/** Agentic chat runs and the insights the agent records. */
export const agent = {
  "agent.run_not_found": {
    action: "none",
    detail: "Run not found",
    description: "The agentic run does not exist.",
  },
  "agent.run_forbidden": {
    action: "none",
    detail: "Not authorized for this run",
    description:
      "The run belongs to another user's private chat or a project the caller cannot see.",
  },
  "agent.no_active_turn": {
    action: "none",
    detail: "No active turn to stop",
    description: "Stop was asked while the run has no turn in progress.",
  },
  "agent.run_missing_project": {
    action: "contact_support",
    detail: "Run is missing project reference",
    audience: "developer",
    description: "A broken invariant (500): the run row has no project, so its turn cannot start.",
  },
  "agent.project_missing_workspace": {
    action: "contact_support",
    detail: "Project is missing a workspace reference",
    audience: "developer",
    description:
      "A broken invariant (500): a workspace- or project-scoped memory was asked for on a project without a workspace.",
  },
  "agent.insight_not_found": {
    action: "none",
    detail: "Insight not found",
    description: "The insight does not exist or belongs to another chat.",
  },
  "agent.insight_content_required": {
    action: "fix_input",
    detail: "content is required",
    description: "An insight was created without content.",
  },
  "agent.insight_content_blank": {
    action: "fix_input",
    detail: "content cannot be blank",
    description: "An insight update set its content to blank text.",
  },
  "agent.insight_update_empty": {
    action: "fix_input",
    detail: "Provide at least one of content, kind, or suggested_capability.",
    description: "An insight update named no field to change.",
  },
  "agent.insight_reason_required": {
    action: "fix_input",
    detail: "reason is required",
    description: "An insight was dismissed without a reason.",
  },
} as const satisfies Codes<"agent">;
