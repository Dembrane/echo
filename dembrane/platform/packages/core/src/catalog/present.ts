import type { Codes } from "./types";

/** Present: the host's presentation draft, its openings and the audience screens. */
export const present = {
  "present.map_not_in_presentation": {
    action: "none",
    detail: "Map is not in this presentation.",
    description: "The audience asked for the map, but the presentation has no map block.",
  },
  "present.activity_not_in_presentation": {
    action: "none",
    detail: "Activity is not in this presentation.",
    description: "The host prepared a block the presentation does not contain.",
  },
  "present.map_results_unavailable": {
    action: "none",
    detail: "Map results are not available.",
    description: "The presentation's pinned map snapshot belongs to another project.",
  },
  "present.map_results_not_ready": {
    action: "wait",
    detail: "Map results are not ready.",
    description: "No map snapshot exists for the project yet.",
  },
  "present.opening_patch_empty": {
    action: "fix_input",
    detail: "The patch names no opening field.",
    audience: "developer",
    description: "An opening publish named no field with a value.",
  },
  "present.draft_conflict": {
    action: "retry",
    detail: "The presentation draft changed elsewhere.",
    description: "The draft was saved from another tab or person since this one loaded it.",
  },
} as const satisfies Codes<"present">;
