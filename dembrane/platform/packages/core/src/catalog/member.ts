import type { Codes } from "./types";

export const member = {
  "member.role_above_own": {
    action: "fix_input",
    detail: "Cannot grant a role higher than your own",
    description: "The caller tried to give someone a role above the caller's own.",
  },
  "member.changed_concurrently": {
    action: "retry",
    detail: "Membership changed concurrently, please retry.",
    description: "Two writes raced on one membership; nothing was saved.",
  },
  "member.invalid_role": {
    action: "fix_input",
    detail: "Invalid role",
    description: "A role change named a role that does not exist at this level.",
  },
  "member.not_found": {
    action: "none",
    detail: "Member not found",
    description: "The person to change or remove is not a member.",
  },
  "member.not_in_workspace": {
    action: "none",
    detail: "Membership not found in this workspace",
    description: "The membership to change or remove belongs to another workspace or none.",
  },
  "member.already_removed": {
    action: "none",
    detail: "Membership already removed",
    description: "The membership to change or remove was already removed.",
  },
  "member.owner_changes_owner": {
    action: "contact_admin",
    detail: "Only an owner can promote to owner or demote another owner",
    params: ["admin_name", "admin_email"],
    description: "A non-owner tried to make or unmake an owner.",
  },
  "member.owner_removes_owner": {
    action: "contact_admin",
    detail: "Only an owner can remove an owner",
    params: ["admin_name", "admin_email"],
    description: "A non-owner tried to remove an owner.",
  },
  "member.last_admin": {
    action: "fix_input",
    detail: "Can't demote the last admin. Promote someone else to admin or owner first.",
    description: "The change would leave no admin or owner.",
  },
  "member.last_admin_remove": {
    action: "fix_input",
    detail: "Can't remove the last admin. Promote someone else first.",
    description: "Removing this person would leave the workspace without an admin.",
  },
  "member.sole_admin_leave": {
    action: "fix_input",
    detail: "You're the only admin. Promote someone else before leaving.",
    description: "The only admin tried to leave the workspace.",
  },
  "member.last_owner": {
    action: "fix_input",
    detail: "Can't remove the last owner. Transfer ownership first.",
    description: "Removing this person would leave no owner.",
  },
  "member.last_owner_demote": {
    action: "fix_input",
    detail: "Cannot demote the last owner. Promote someone else first.",
    description: "The change would leave the workspace without an owner.",
  },
  "member.outsider_role_switch": {
    action: "fix_input",
    detail:
      "Cannot change an outside collaborator (external or observer) into a member, or vice versa, from this dropdown. Re-invite the user to the workspace with the new role instead.",
    description: "A role change crossed between outside collaborator and member roles.",
  },
} as const satisfies Codes<"member">;
