---
title: Notifications
description: How dembrane keeps you informed - in-app and email notifications, digest batching, tier-expiry warnings, workspace-request alerts, and how to manage what you receive.
audience: all
---

# Notifications

Notifications tell you something happened without making you go looking for it. They arrive
in two places - the dashboard bell and your *email* - and dembrane is deliberately quiet:
it batches email so a busy day doesn't bury you in one-line alerts.

Everyone with an account can receive them. Some, like workspace-request alerts, are aimed at
[admins](./roles-and-permissions.md) who can act on them. You manage what you receive in
your [account & security](./account-and-security.md) settings.

## In-app vs email

The dashboard bell is *always immediate* and shows everything in real time. Email is the
gentler channel, where the batching below kicks in. If you want the full, immediate picture,
check the bell.

## Digest batching

dembrane doesn't email you every event the moment it happens:

- The *first 5 notifications in a rolling 24-hour window* are emailed *individually* - the
  ones you most likely want straight away.
- After that, the rest are *rolled into a daily digest* sent once a day at *09:00 UTC*.

So a normal day sends a handful of timely emails; a very busy day sends those plus a single
morning summary, instead of dozens of separate messages.

## What you'll be notified about

*Workspace requests.* When someone asks to *create a workspace* or *upgrade a tier*, the
admins who can approve it are notified, in-app and by email (within the batching rules).
This is the free-tier upgrade flow; admins act on it in the dashboard, and staff see it
under [upgrade requests](../users/staff/upgrade-requests.md).

*Tier expiry.* If a workspace's tier is set to expire - a time-limited trial, say - dembrane
sends a *prewarning three days before* it lapses, so there's time to renew or plan rather
than discovering it after the fact.

## Subscribing and unsubscribing

- *Preferences* live in your [account & security](./account-and-security.md) settings.
- *Email* notifications can be unsubscribed from - every email includes the means to opt out
  of that kind.
- Some notifications are also surfaced as *portal* subscription options for participant
  reports, configured separately in the [portal editor](./portal-editor.md).

> [!NOTE]
> Unsubscribing from emails doesn't silence the bell - you'll still see notifications in the
> dashboard. The two channels are managed independently, so you can stay informed without a
> noisy inbox.

## Related

- [Account & security](./account-and-security.md) - where you manage notification
  preferences.
- [Upgrade requests (staff)](../users/staff/upgrade-requests.md) - the workspace-request flow
  behind those alerts.
- [Tiers & billing](./tiers-and-billing.md) - what tier expiry means and how to renew.
