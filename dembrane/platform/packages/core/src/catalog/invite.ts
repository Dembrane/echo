import type { Codes } from "./types";

export const invite = {
  "invite.not_found": {
    action: "none",
    detail: "Invite not found",
    description: "The invite does not exist, was revoked, or was already handled.",
  },
  "invite.not_for_you": {
    action: "sign_in",
    detail: "This invite isn't for you",
    description: "The invite was sent to another email address than the signed-in user's.",
  },
  "invite.already_accepted": {
    action: "none",
    detail: "Invite already accepted",
    description: "The invite was accepted before; there is nothing left to do with it.",
  },
  "invite.expired": {
    action: "contact_admin",
    detail: "Invite has expired",
    params: ["admin_name", "admin_email"],
    description: "The invite is past its expiry date; the inviter has to send a new one.",
  },
  "invite.self": {
    action: "fix_input",
    detail: "Cannot invite yourself",
    description: "The invite names the inviter's own email address.",
  },
  "invite.resend_forbidden": {
    action: "contact_admin",
    detail: "Only the inviter or an org admin can resend",
    params: ["admin_name", "admin_email"],
    description: "Resending an invite needs its inviter or an organisation admin.",
  },
  "invite.revoke_forbidden": {
    action: "contact_admin",
    detail: "Only the inviter or a workspace or org admin can revoke",
    params: ["admin_name", "admin_email"],
    description: "Revoking an invite needs its inviter or a workspace or organisation admin.",
  },
  "invite.outsider_is_member": {
    action: "fix_input",
    detail:
      "This person is already a member of the organisation and cannot also be added as an outside collaborator. Remove them from the organisation first.",
    description: "An outside-collaborator invite names someone who is an organisation member.",
  },
  "invite.outsider_is_admin": {
    action: "fix_input",
    detail:
      "This person is an organisation admin, owner, or billing member and cannot be added as an outside collaborator. Change their organisation role first.",
    description:
      "An outside-collaborator invite names an organisation admin, owner or billing member.",
  },
  "invite.observer_internal_workspace": {
    action: "fix_input",
    detail:
      "Observers are only available in workspaces for an external client. This workspace is for internal use.",
    description: "The observer role was asked for in an internal workspace.",
  },
  "invite.role_cannot_access_projects": {
    action: "fix_input",
    detail: "role_cannot_access_projects",
    description:
      "An invite with project shares names a role (billing) that cannot open projects; details carry code and message.",
  },
} as const satisfies Codes<"invite">;
