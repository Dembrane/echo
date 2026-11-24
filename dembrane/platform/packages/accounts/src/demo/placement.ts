import type { Conn } from "../deps";
import { store } from "../storage";

/**
 * Whether a demo may go into an organisation its contact already works in: the organisation
 * exists and is not deleted, and the contact has an account and is a live member of it.
 * Asked when staff start the demo (a refusal is a field error on `org_id`) and again by the
 * seed step, which may run later (a refusal is a sentence staff read on the demo's page).
 */
export async function placement(c: Conn, orgId: string, contactEmail: string) {
  const org = await store.org(c, orgId);
  if (!org) return { ok: false, problem: "organisation_missing" } as const;
  if (org.deleted_at) return { ok: false, problem: "organisation_deleted" } as const;
  const identity = await store.identityByEmail(c, contactEmail.trim());
  const contact = identity ? await store.appUserByDirectusId(c, identity.id) : null;
  if (!identity || !contact) return { ok: false, problem: "no_account" } as const;
  const [membership] = await store.liveOrganisationsOf(c, contact.id, { orgId });
  if (!membership) return { ok: false, problem: "not_member" } as const;
  return {
    ok: true,
    org: { id: org.id, name: org.name ?? "" },
    contact: { appUserId: contact.id, directusUserId: identity.id },
  } as const;
}

export type PlacementProblem = Extract<
  Awaited<ReturnType<typeof placement>>,
  { ok: false }
>["problem"];

/** What the seed step says when the organisation or the contact changed since the start. */
export const PLACEMENT_PROBLEM: Record<PlacementProblem, string> = {
  organisation_missing:
    "The organisation chosen for this demo no longer exists. Start the demo again for another organisation.",
  organisation_deleted:
    "The organisation chosen for this demo was deleted after the demo was started. Restore it and retry, or start the demo again for another organisation.",
  no_account:
    "The contact no longer has a dembrane account. Start the demo again with a new organisation for them.",
  not_member:
    "The contact is no longer a member of the organisation chosen for this demo. Add them back and retry, or start the demo again for another organisation.",
};

/**
 * The code publishing with the email on answers when the check fails then: the organisation
 * is gone, or the contact is not in it any more (an account removed counts as not in it).
 */
export function publishRefusal(
  problem: PlacementProblem,
): "demo.organisation_deleted" | "demo.contact_not_in_organisation" {
  return problem === "organisation_missing" || problem === "organisation_deleted"
    ? "demo.organisation_deleted"
    : "demo.contact_not_in_organisation";
}

/** What publishing with the email on says when the same check fails then; nothing is published. */
export const PUBLISH_PROBLEM: Record<PlacementProblem, string> = {
  organisation_missing:
    "The organisation chosen for this demo no longer exists, so the demo was not published. Publish with the email off, or start the demo again for another organisation.",
  organisation_deleted:
    "The organisation chosen for this demo was deleted after the demo was built, so the demo was not published. Restore it and publish again, or publish with the email off.",
  no_account:
    "The contact no longer has a dembrane account, so the demo was not published. Publish with the email off, or start the demo again with a new organisation for them.",
  not_member:
    "The contact is no longer a member of the organisation chosen for this demo, so the demo was not published. Add them back and publish again, or publish with the email off.",
};
