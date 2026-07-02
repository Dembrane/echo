---
title: Trainings & licences
description: Staff training administration - the catalogue, scheduling sessions, completing them to grant one-year licences, and managing the roster.
audience: staff
---

# Trainings & licences

dembrane runs *trainings* for people deploying it in high-risk or regulated settings - the
sessions that make sure facilitators can collect, handle, and analyse sensitive conversations
responsibly. Completing a training grants each attendee a *one-year licence*, the record that
they've been trained.

This page is the staff side: the catalogue, scheduling sessions, completing them to issue
licences, and managing the roster. It's the *Training* section of the
[admin panel](./admin-panel-overview.md#the-sections). The customer-facing view is on
[trainings](../../features/trainings.md).

## What trainings are for

These aren't product tutorials - those live in the [help resources](../../features/index.md).
Trainings here are *compliance trainings*: structured sessions for people running dembrane
where the stakes are high (sensitive cohorts, regulated processes, public consultations that
demand careful data handling). The one-year licence is the evidence someone completed one.

## The catalogue

The catalogue is the set of trainings dembrane offers. You *create* and *update* trainings
here. Each has a *mode*:

- *online* - delivered remotely.
- *in_person* - delivered face to face.
- *flex* - either, as the situation needs.

The catalogue is the template layer: a training defines *what* the session is. A scheduled
session is an *instance* of one, with a date and a roster.

## Creating and scheduling a session

To run a training, pick or create the training in the catalogue and *schedule* a session -
set its date and mode, then build the *roster* of attendees. The roster is the list licences
are issued against when you complete the session, so get the right people on it first.

> [!TIP]
> Build the roster as registrations come in. Licences aren't granted until you
> [complete](#completing-a-session--granting-licences) the session, so a last-minute change
> before completion is no problem.

## Completing a session → granting licences

When the session has happened, *complete* it. Completion grants a one-year `training_license`
to every person on the roster. That licence:

- Lasts one year from when it's granted.
- Is recorded per user, so each attendee carries their own.
- Is the record other parts of dembrane can check to confirm someone's been trained.

> [!IMPORTANT]
> Completing is the moment licences are issued. Get the roster right *before* you complete -
> far cleaner than issuing to the wrong list and then
> [revoking](#editing-and-revoking-licences). If someone didn't attend, take them off first.

## The roster

The roster is the attendee list for a session - who's expected, and (after completion) who was
granted a licence. Add and remove people before completion; read it afterwards as the record
of who the session licensed.

## Editing and revoking licences

You can *edit* a licence (correct a detail) or *revoke* it (remove it) when:

- The wrong person was granted one.
- Someone withdrew or shouldn't hold a current licence.
- A correction is needed after the fact.

Revoking removes the licence; the person no longer counts as trained until granted a new one
(by completing another session).

> [!NOTE]
> A licence expires after a year on its own - you don't have to revoke it to end it. Revoke is
> for when it shouldn't run its full term. To renew someone, put them on the roster of a fresh
> session and complete it.

## The training flow, end to end

1. *Create or pick* the training in the [catalogue](#the-catalogue), with its mode.
2. *Schedule* a session - date and mode.
3. *Build the roster* of attendees.
4. Run the session.
5. *Complete* it → every roster member gets a
   [one-year licence](#completing-a-session--granting-licences).
6. *Edit or revoke* any licence that needs correcting afterwards.

## Related

- [Trainings](../../features/trainings.md) - the customer-facing view: what a trained user
  sees about their licence.
- [The admin panel](./admin-panel-overview.md) - the Training section and how to reach it.
- [Staff overview](./index.md) - the admin gate that lets you run trainings at all.
- [Roles & permissions](../../features/roles-and-permissions.md) - how trained users fit the
  wider role model.
