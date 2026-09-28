import type { Codes } from "./types";

export const report = {
  "report.not_found": {
    action: "none",
    detail: "Report not found",
    description: "The report does not exist, was deleted, or belongs to another project.",
  },
  "report.schedule_invalid": {
    action: "fix_input",
    detail: "Invalid scheduled_at datetime format: {value}",
    description: "The report's scheduled time does not parse as an ISO date or datetime.",
  },
  "report.schedule_too_soon": {
    action: "fix_input",
    detail: "Scheduled time must be at least 10 minutes in the future",
    description: "A scheduled report must start at least ten minutes from now.",
  },
  "report.already_generating": {
    action: "wait",
    detail: "A report is already being generated for this project",
    description: "One report draft at a time per project; another is still generating.",
  },
  "report.not_scheduled": {
    action: "none",
    detail: "Report is not scheduled",
    description: "Only a scheduled report can be published early.",
  },
} as const satisfies Codes<"report">;
