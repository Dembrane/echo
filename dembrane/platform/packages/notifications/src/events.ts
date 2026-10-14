export type NotificationAction =
  | "NONE"
  | "NAVIGATE_WS"
  | "NAVIGATE_PROJECT"
  | "NAVIGATE_REPORT"
  | "NAVIGATE_PRESENT"
  | "NAVIGATE_CHAT"
  | "NAVIGATE_INVITE"
  | "NAVIGATE_ORGANISATION_SETTINGS"
  | "NAVIGATE_WORKSPACE_SETTINGS"
  | "NAVIGATE_BILLING"
  | "NAVIGATE_TRAINING";

export type NotificationSeverity = "info" | "action_required" | "destructive";

/**
 * Row styling in the inbox (frontend Inbox.tsx keeps the same list). Anything not listed is
 * "info"; passive events such as WORKSPACE_GUEST_ADDED stay out on purpose.
 */
const SEVERITY: Record<string, NotificationSeverity> = {
  WORKSPACE_REMOVED: "destructive",
  ORGANISATION_REMOVED: "destructive",
  PROJECT_NOW_PRIVATE: "destructive",
  PROJECT_SHARE_REVOKED: "destructive",
  TIER_DOWNGRADED: "destructive",
  INVITE_CANCELLED: "destructive",
  REPORT_FAILED: "destructive",
  MEMBERSHIP_REQUESTED: "action_required",
  INVITE_RECEIVED: "action_required",
  INVITE_BLOCKED_AT_CAP: "action_required",
  INVITE_PENDING_AT_CAP: "action_required",
  WORKSPACE_REQUEST_SUBMITTED: "action_required",
  TIER_EXPIRED: "destructive",
  TIER_EXPIRING_SOON: "action_required",
  TRAINING_REQUESTED: "action_required",
  PARTNER_HANDOFF_PENDING: "action_required",
  ONBOARDING_FOLLOWUP: "action_required",
  PAYMENT_FAILED: "action_required",
  SUPPORT_ACCESS_REQUESTED: "action_required",
  SUPPORT_ACCESS_REMINDER: "action_required",
};

export function severityFor(eventCode: string): NotificationSeverity {
  return SEVERITY[eventCode] ?? "info";
}
