import type { Codes } from "./types";

/** The data room of a customer account: the colleagues who read the offer and the DPA. */
export const room = {
  "room.manage_forbidden": {
    action: "none",
    detail: "Only the person who invited them, an admin or Billing can change what they do",
    description:
      "A room member re-added someone already in the room whom they did not invite, to change their labels.",
  },
  "room.remove_forbidden": {
    action: "none",
    detail: "Only the person who invited them, an admin or Billing can take them out",
    description: "A room member tried to take out someone they did not invite.",
  },
  "room.person_not_found": {
    action: "none",
    detail: "This person is not in the room",
    description:
      "The room person does not exist, was taken out already, or is another organisation's.",
  },
  "room.in_by_role": {
    action: "none",
    detail: "Owners, admins and Billing are in the room by their role",
    description:
      "Taking someone out of the room who is there by their organisation role; changing the role is the way.",
  },
  "room.labels_already_answered": {
    action: "none",
    detail: "You already said what you do here",
    description: "The once-asked question about one's own labels was answered before.",
  },
  "room.no_labels_question": {
    action: "none",
    detail: "There is no question about your labels",
    description:
      "Someone answered the labels question who was not brought into the room by someone else.",
  },
  "room.new_person_admins_only": {
    action: "contact_admin",
    detail:
      "Only an owner, admin or Billing can bring someone new in here: as a member they would reach the workspaces open to everyone in the organisation",
    params: ["workspaces"],
    description:
      "A room member tried to invite someone who is not a member, in an organisation with a workspace every member joins; `workspaces` is how many.",
  },
} as const satisfies Codes<"room">;
