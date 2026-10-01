import type { Codes } from "./types";

/** Analysis results: runs, snapshots, result objects and their revisions. */
export const analysis = {
  "analysis.storage_unavailable": {
    action: "retry",
    detail: "Analysis storage is unavailable.",
    description: "The analysis store did not answer; nothing was read or written.",
  },
  "analysis.object_not_found": {
    action: "none",
    detail: "Object not found",
    description: "The result object does not exist or belongs to another project.",
  },
  "analysis.revision_not_found": {
    action: "none",
    detail: "Revision not found",
    description: "The revision named by the request does not exist for this result.",
  },
  "analysis.run_not_found": {
    action: "none",
    detail: "Run not found",
    description: "The analysis run does not exist or belongs to another project.",
  },
  "analysis.snapshot_not_found": {
    action: "none",
    detail: "Snapshot not found",
    description: "The analysis snapshot does not exist or belongs to another project.",
  },
  "analysis.host_not_found": {
    action: "none",
    detail: "Host not found",
    audience: "developer",
    description: "The caller has no Directus user, so feedback cannot be attributed.",
  },
  "analysis.feature_disabled": {
    action: "none",
    detail: "Not found",
    description: "Editing results (the Present feature) is switched off on this deployment.",
  },
  "analysis.recipe_internal": {
    action: "none",
    detail: "This recipe runs only from its own feature.",
    audience: "developer",
    description: "A recipe that another feature starts was requested directly.",
  },
  "analysis.invalid_request": {
    action: "fix_input",
    detail: "Invalid analysis request",
    description:
      "The analysis layer refused the request's parameters or payload; the detail carries its reason.",
  },
  "analysis.unknown_scope": {
    action: "fix_input",
    detail: "Unknown result scope",
    audience: "developer",
    description: "The results were asked for a scope the analysis layer does not know.",
  },
  "analysis.unknown_object_type": {
    action: "fix_input",
    detail: "unknown object type {type}",
    audience: "developer",
    description: "The objects query named a type that is not a map type.",
  },
  "analysis.read_only_type": {
    action: "none",
    detail: "This result type is read-only.",
    description: "An edit was sent for a result type that cannot be edited.",
  },
  "analysis.payload_or_patch": {
    action: "fix_input",
    detail: "Send either the payload or a patch of fields to change.",
    audience: "developer",
    description: "A revision edit carried both or neither of payload and patch.",
  },
  "analysis.field_not_editable": {
    action: "fix_input",
    detail: "{field} cannot be edited here.",
    description: "A revision edit changed a field this result type does not let people edit.",
  },
  "analysis.revision_conflict": {
    action: "retry",
    detail: "This result changed while you were reviewing it.",
    description:
      "The result has a newer revision than the one the edit started from; the detail carries the current one.",
  },
  "analysis.feedback_tag_mismatch": {
    action: "fix_input",
    detail: "{tag} is not a reason for a thumbs {rating}.",
    audience: "developer",
    description: "A feedback tag of the other polarity was sent with a rating.",
  },
} as const satisfies Codes<"analysis">;
