---
title: Data ownership & compliance
description: Who owns the conversations in a workspace - internal vs external workspaces, the data owner, partner agreements, white labeling, and dembrane's EU and GDPR posture.
audience: all
---

# Data ownership & compliance

Every workspace belongs to someone, and dembrane is explicit about *who*. A workspace is
either *internal* - your organisation's own work, on your billing and branding - or
*external* - work you run for a named client, billed separately, with the client recorded
as the *data owner*. That one choice shapes billing, branding, and who can see what.

You'll reach for this when you decide whether a new workspace is yours or a client's, when
a client asks "where is our data and who can access it?", or when a compliance officer
wants to know dembrane's GDPR stance. The internal/external choice is made by a workspace
[admin or owner](./roles-and-permissions.md) when creating or editing a workspace.

## Internal vs external

| | Internal workspace | External workspace |
|---|---|---|
| Billing | Shares the organisation's *pooled* seats | Its *own* workspace-scoped account |
| Branding | Inherits the organisation's logo | Can be *white-labelled* per workspace |
| Data owner | The organisation itself | A *named external client* (org name + email) |
| Free observers | Not allowed | *Allowed* - the data owner is auto-invited as one |

Internal is the default and the right choice for your own team. External is for work you
run for someone else - see [the partner program](./partner-program.md), which is built
around external-client workspaces.

## The data owner

On an external workspace, dembrane records the *data-owner organisation name* (e.g.
"Provincie Utrecht") and the *data-owner email* - the specific person who owns the
conversations. When that person logs in and their email matches, the workspace shows a
"this is yours" marker in their list, without exposing anyone else's details. It also
drives the automatic free-observer invite, so the data owner can watch progress at no cost.

> [!NOTE]
> The data owner is the *client* who owns the conversations, not the host who runs the
> sessions. A partner agency facilitates; the client owns. Keeping those separate is the
> whole point of an external workspace.

When you create an external-client workspace you also confirm a *partner agreement* - a
checkbox stating you and the client have agreed terms for handling their data. dembrane
stores the moment you accepted it: a lightweight, auditable record that the relationship
was acknowledged before any conversations were collected.

## White labelling

White labelling puts a client's (or your own) logo on the
[participant portal](./portal-and-participant-experience.md) instead of dembrane's. It's
*external-workspace-only*, on [Changemaker](./tiers-and-billing.md) and above. For a
partner, each engagement can carry the client's identity - the people you record see the
client's brand, not yours and not dembrane's.

## EU & GDPR posture

dembrane is built for European, privacy-sensitive work:

- *GDPR.* Designed to be GDPR-compliant - lawful basis is captured per project, and
  personal data can be removed (see *anonymisation* below).
- *ISO 27001.* dembrane operates to ISO 27001 information-security practices.
- *EU co-funded.* dembrane's development has been co-funded within the EU.
- *EU hosting.* Built-in analysis runs on EU-hosted models; transcription is handled
  securely. Self-hosters can pin everything to EU regions - see
  [self-hosting](../users/developer-external/self-hosting.md).

> [!IMPORTANT]
> For the authoritative legal documents - the privacy statement, terms, and the data
> processing agreement - see dembrane's legal pages and privacy statements (linked from the
> dashboard). This page describes posture, not legal terms.

### Anonymisation

dembrane can *anonymise transcripts* so personal data is removed during processing. When
enabled per project in the [portal editor](./portal-editor.md), the pipeline redacts
identifiable information as it cleans up the text, and each conversation shows its
anonymisation status. This matters when you collect from members of the public who
shouldn't be re-identifiable in the analysis. The redaction mechanics are under
[transcription](./transcription.md).

### Guardian - the EU-sovereign stack (coming soon)

The *Guardian* tier adds a fully *EU-sovereign* stack: hosting and language models that sit
entirely within European jurisdiction and aren't exposed to extraterritorial data requests.
It's aimed at the most sensitive work, where even EU-hosted-but-US-owned infrastructure
isn't acceptable. Guardian is *coming soon*, gated on the sovereign stack shipping - see
[tiers & billing](./tiers-and-billing.md) for where it sits.

## Related

- [The partner program](./partner-program.md) - external-client workspaces in practice.
- [Tiers & billing](./tiers-and-billing.md) - where white labelling (Changemaker+) and the
  Guardian sovereign stack live.
- [Transcription](./transcription.md) - secure, multilingual transcription and PII
  redaction.
- [Roles & permissions](./roles-and-permissions.md) - who can change data-ownership
  settings.
