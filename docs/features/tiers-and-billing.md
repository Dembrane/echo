---
title: Tiers & billing
description: The dembrane plans, what the free plan includes, what needs a paid plan, how seats are counted, how you get a paid plan, and what the billing pages show.
audience: all
---

# Tiers & billing

Every organisation starts on the free plan. You cannot buy a plan in the dashboard: there
is no checkout and no plan picker. You tell dembrane what you need, book a call, and get an
offer to sign. For prices, ask dembrane.

A plan (the product also says "tier") belongs to a billing account, not to a single
workspace. See [billing accounts](#billing-accounts).

## The plans

There are four plan names, in this order: Free, Innovator, Changemaker, Guardian.

- Free is where everyone starts.
- Changemaker is the paid plan you can get today.
- Innovator and Guardian are names in the product. Neither can be bought.

Where the product says a feature needs "the innovator plan or above", read that as
Changemaker.

## What the free plan includes

| | On the free plan |
|---|---|
| Recorded audio | 1 hour for each workspace, counted over the whole life of the workspace, not each month. Deleted conversations still count |
| Workspaces | 1 on your organisation's plan. A workspace for an external organisation is not counted |
| Chat | 1 chat for each workspace, with 3 questions. Deleting the chat frees the place |
| Reports | 1 for each workspace. Deleted reports do not count |
| [Agent (MCP)](./mcp-and-bring-your-own-llm.md) tool calls | 1,000 each calendar month for the whole organisation |
| People | No limit. The free plan is not limited to one user |

The free plan does not include the features in the next table.

When the free hour is used up:

- Participants are never stopped. The portal keeps working.
- A conversation that started inside the hour stays open to you.
- Later conversations are locked for the host: the transcript and the summary are held
  back. A locked conversation gets its summary after the workspace moves to a paid plan.
- You cannot upload recordings ("Upload limit reached") or use the microphone in chat.
- dembrane tells you: "Your free transcription hour is used up."

## What needs a paid plan

| Feature | Plan | Who can use it |
|---|---|---|
| More than 1 hour of audio, 1 workspace, 1 chat with 3 questions, 1 report | any paid plan | |
| Agent (MCP) tool calls that are not counted | any paid plan, on at least one workspace of the organisation | |
| Hide the dembrane event invitation in the portal | any paid plan | anyone who can edit the project |
| A workspace that is "Invite only" or "Private" | Innovator or above | workspace admins, and organisation admins when they create it |
| A private project, and sharing it | Innovator or above | workspace admins |
| A public page for a [presentation](./present.md) (Beta) | Innovator or above | workspace admins |
| A custom workspace logo | Changemaker or above | workspace admins |
| Webhooks, on the project's "Automation" page (Beta) | Changemaker or above | workspace admins |
| Taking "made with dembrane" off a presentation | Changemaker or above | |

Going back is always free: making a project visible to the workspace again, or setting a
workspace back to "Everyone in your organisation", needs no plan.

A feature your plan does not include shows the badge "Available on a paid plan". A control
you cannot use opens one short line, such as "The free plan includes one report.", with the
link "Tell us what you need".

## How you get a paid plan

1. Choose "Tell us what you need". You find it at every limit, and on the billing page
   under "Current plan".
2. Answer the questions in "Can you tell us more?". There are six short steps and nothing
   is required. dembrane asks what you want to use it for, when you need it, how many
   recordings you expect in your first year, how many conversations run at the same time at
   your busiest moment, and whether you need anything else. You can speak your answers:
   "Prefer talking? Press record and just say it."
3. Choose "Pick a time" and book a call with the dembrane team. You then read "Your call is
   booked: {time}." and "The invite is in your inbox. We will read your answers before then
   and bring a draft offer."
4. dembrane sends your organisation an offer. You sign it in the dashboard and fill in your
   billing details. See [offers & invoices](./offers-and-invoices.md).
5. dembrane puts your account on the plan. Signing the offer does not switch the plan by
   itself.

You can also write to support@dembrane.com.

## Seats

A seat is one person. Plans are counted in seats.

- These roles take a seat: Admin, Member, Billing and External. Observers are free.
- A person is one seat for each billing account, however many of its workspaces they are
  in. Someone in three workspaces of the same account is one seat, not three.
- Only people who are members of a workspace count. An organisation admin who reaches a
  workspace through their organisation role takes no seat. dembrane staff on a
  [support visit](./staff-support-access.md) take no seat.
- An open invite is not billed. It counts once the person accepts. The billing page says
  "{pendingInvites} invite(s) pending. Counted once accepted."
- No plan has a seat limit. An invite is never refused for the number of people.
- One thing blocks an invite to a paid role: a plan that is cancelled or has a payment
  overdue. Observer invites still go through.

## Billing accounts

Every workspace is paid for by one billing account, and the plan sits on that account.

- Your organisation has one account for all its internal workspaces. They share the plan
  and the seats. A plan change applies to all of them together.
- A workspace "For an external organisation" has its own account. It starts on the free
  plan, whatever plan your organisation has. Its plan badge reads "{Tier} (partner)":
  "Billed separately, not part of the organisation's plan." Someone who is in that
  workspace and in your internal workspaces holds a seat on each account. See
  [the partner program](./partner-program.md).

## Where you see usage and billing

| Where | What it shows | Who can open it |
|---|---|---|
| Workspace settings, "Usage and billing" | "Usage · {month}" with "Audio", "Seats", "Members", "Externals", "Observers (free)", "Pending invites" and "Projects" | Usage: admins, members and Billing. Invoices and payment: admins and Billing. Externals and observers see neither |
| Organisation settings, "Usage" | "Organisation usage" for each workspace: "Tier", "Hours", "Seats", "Status". A workspace on its own account shows "Billed separately" | Organisation admins and Billing |
| Organisation settings, "Billing" | The plan, and the list "Workspaces billed separately" | Organisation admins and Billing |

Usage is shown for each calendar month, up to 12 months back.

What the billing page shows depends on the account:

- A workspace on your organisation's plan: "Billing is managed by your organisation", with
  "Manage organisation billing".
- A workspace on its own account: "This workspace is billed separately".
- The free plan: "You are on the free plan. There is no payment to manage yet." and "Tell
  us what you need".
- A paid plan arranged without a payment in the dashboard: the badge "Arranged with
  dembrane".
- A plan that dembrane invoices: the badge "Managed by dembrane" and "Your plan is managed
  by dembrane. Contact your account manager to make changes.", with your seats, your
  account manager, your invoices and your billing details.
- A subscription you pay by card or direct debit: see the next section.

Invoices that follow a signed offer are under "Documents" in your organisation. See
[offers & invoices](./offers-and-invoices.md).

## If you already pay by card or direct debit

This applies if your organisation holds a subscription that is charged through the payment
provider Mollie, each year or each month. Your billing page then shows "Current plan",
"Seats", "Next invoice", "Payment method", "Invoices" and "Billing details".

- Adding a person in the middle of a period gives one extra charge for the rest of that
  period. Removing a person gives no refund. The seat stays paid until renewal and you can
  fill it again at no charge.
- If a charge fails, your plan stays active. The admins of the account get a notice and the
  email "Your payment to dembrane didn't go through". The page shows "We couldn't charge
  your payment method" with "Try again" and "Change payment method".
- "Change payment method" does not charge you: "You'll verify your new payment method on
  the next screen. You won't be charged, it just confirms the new card."
- "Cancel plan" stops the renewal. You keep the plan until the period ends: "Ends on
  {endDate}, then moves to Free". Until then "Resume plan" turns it back on without a new
  charge.
- "Invoices" lists your payments with "Date", "Description", "Amount" and "Status". An open
  charge shows "Pay now".

## When a plan ends or moves down

- A plan with an end date moves to Free when the date passes. Workspace admins and Billing
  members get a notice and the email "{workspace_name} is now on the free plan". A workspace
  that is billed on its own also gets a warning three days before.
- When a workspace moves to a lower plan, what you already made stays: private workspaces,
  private projects, the people a private project is shared with, and webhooks, which keep
  firing. You cannot make new ones. A custom logo is removed.
- The workspace shows a banner for 7 days: "This workspace was downgraded to {tier} on
  {sinceDate}. Some features are limited." Workspace admins and Billing members also get a
  notice and the email "{workspace_name} moved to {to_tier}".

## Related

- [Offers & invoices](./offers-and-invoices.md): signing an offer, billing details and invoices.
- [Roles & permissions](./roles-and-permissions.md): which roles take a seat and who sees billing.
- [Invites & access](./invites-and-access.md): what happens when you add people.
- [Organisations & workspaces](./organisations-and-workspaces.md): which workspaces share an account.
- [The partner program](./partner-program.md): workspaces with their own billing.
- [Tiers, billing and usage for hosts](../users/host/tiers-billing-and-usage.md): the same, as a host.
