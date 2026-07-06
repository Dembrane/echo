---
title: Managing your workspace - for hosts
description: As an owner or admin, run your workspace - members, invites and roles, visibility, data ownership, and settings.
audience: host
---

# Managing your workspace (for hosts)

A workspace holds your [projects](../../features/projects.md), conversations and people. If
you're the owner or an admin, you run it: who's in, what they can do, who can see what. This is
the quick how-to for those controls. Members can create and edit projects but not invite people
or change settings; if you can't see the controls below, you're probably a member or
collaborator. The full breakdown is in [roles & permissions](../../features/roles-and-permissions.md).

## Add and manage people

Open your workspace and go to *Settings → Members*. From here you add people, set roles, and
remove them.

To invite, by *email* or *link*, pick a role:

| You want them to… | Give them |
|---|---|
| Co-run the workspace with you | *admin* |
| Create and edit projects - the everyday role | *member* |
| See usage, invoices and payment, nothing else | *billing* |
| Collaborate from outside (edit, chat, build reports) but not create/delete projects, invite or publish | *external* |
| Only view, free and read-only ([external-client](../../features/partner-program.md) workspaces only) | *observer* |

Email invites expire after *7 days*; link invites are the alternative when email is awkward.
Pending invites and any access requests show up in the members area to approve or chase.

> [!IMPORTANT]
> You can't grant a role above your own. An admin can invite members and admins, but only an
> owner can hand out owner-level access.

To change a role, adjust it in the members list; remove people when they leave. One quirk:
there's no "convert external to member" button. To promote an external collaborator, remove the
external entry, add them to the organisation, and re-invite as a member - deliberate, because it
crosses the org boundary. See [invites & access](../../features/invites-and-access.md).

Most roles take a *seat* (owner, admin, member, billing, external); observer is free.
Seats are metered, never blocked - inviting never hits a wall, the count just shows in your
[usage](./tiers-billing-and-usage.md). A person counts once per workspace, pooled across a
billing account.

## Set who can see the workspace

Visibility controls who in your organisation can discover and join. Three states:

- *Open to organisation* - everyone in the org sees it; org admins auto-join. Free at every
  tier, and the default.
- *Invite-only* - invited people plus org admins.
- *Private* - invited people only; org admins do not auto-join (the org owner can still carve in).

The only paywalled move is leaving *open to organisation* - making a workspace more private
needs Innovator or above. See [visibility & discovery](../../features/visibility-and-discovery.md).

> [!TIP]
> Start open if your team trusts each other - least friction. Tighten only when a workspace
> genuinely needs walling off.

## Internal or external-client

In *Settings → Data ownership*, set whether this is an *internal* workspace (shares the org's
pooled billing, inherits org branding) or an *external-client* one (names a separate data owner,
bills on its own, allows free observers, supports white-labelling). External-client is the
[partner](../../features/partner-program.md) setup - read
[data ownership & compliance](../../features/data-ownership-and-compliance.md) if you run work
for outside clients. For an ordinary team workspace, leave it internal.

## Give the assistant standing context

*[dembrane next only](../../features/dembrane-next.md).* If your team uses
[Ask's agentic mode](./chat-and-ask.md#agentic-mode), the workspace *General* settings carry
two things for it:

- *Assistant context* - guidance you write once that reaches every project chat in the
  workspace (*"We're a research agency; reports go to municipal clients, keep summaries formal
  and in Dutch"*). Admins edit it; it saves as you leave the field.
- *Assistant memory* - notes the assistant saved about the workspace from people's chats.
  Anyone in the workspace shares them; *Remove* makes it forget one. The assistant writes
  these; people can only view and remove them.

Project-level guidance stays on the project: its *context* field and an *Assistant memory*
section in project settings work the same way, one project at a time.

## Other settings

The rest of *Settings* is everyday setup: *name & logo* (per-workspace white-labelling is
external-client only), *billing & usage* (your plan, seats, recording hours, invoices), and
*inherit organisation branding* for internal workspaces. If you run several workspaces, the
*organisation* around them is managed from org settings - members-by-workspace, access requests,
pending invites, and an org-wide usage rollup. Org membership is independent of any single
workspace.

## Related

- [Roles & permissions](../../features/roles-and-permissions.md) - every role and exactly what
  it can do.
- [Invites & access](../../features/invites-and-access.md) - adding people by email or link, and
  access requests.
- [Visibility & discovery](../../features/visibility-and-discovery.md) - open, invite-only, or
  private.
- [Organisations & workspaces](../../features/organisations-and-workspaces.md) - the containers
  and how they nest.
- [Data ownership & compliance](../../features/data-ownership-and-compliance.md) - internal vs
  external, and who owns what.
- [Tiers, billing & usage](./tiers-billing-and-usage.md) - seats, plans, and what's gated.
