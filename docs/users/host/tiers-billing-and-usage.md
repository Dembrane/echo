---
title: Tiers, billing & usage
description: What the dembrane plans include and limit, how seats and usage are counted, where to see them, and how to move to a paid plan.
audience: host
---

# Tiers, billing & usage

Your plan decides how much you can record and which extras you get. You cannot buy a plan
inside the dashboard. You tell dembrane what you need, have a call, and sign an offer. This
page has no prices: [ask dembrane](#move-to-a-paid-plan) for those.

A plan belongs to a billing account, not to a single workspace. The workspaces your
organisation uses itself share one plan. A workspace made for an external organisation has its
own plan and starts on Free. While your organisation is on Free too, that workspace shares your
free allowance.

## The plans

There are four plans, in this order: Free, Innovator, Changemaker and Guardian. A higher plan
includes everything a lower one has.

| What you want | Plan you need |
|---|---|
| More than 5 hours of recording a month, or conversations longer than 1 hour | Any paid plan |
| Recording in more than one project | Any paid plan |
| More than one project | Any paid plan |
| More AI than the free plan's monthly AI allowance | Any paid plan |
| A second workspace on your organisation's plan | Any paid plan |
| Hide the dembrane event invitation in the portal | Any paid plan |
| Private projects, and sharing them with chosen people | Innovator or higher |
| An "Invite only" or "Private" workspace | Innovator or higher |
| A public page for a presentation | Innovator or higher |
| Your own workspace logo | Changemaker or higher |
| Webhooks ("Manage", "Advanced") | Changemaker or higher |
| The room screen without the "made with dembrane" mark | Changemaker or higher |

No plan caps the number of seats, and paid plans have no cap on recording hours.

## The free plan

| Limit | Free plan |
|---|---|
| Recording | 5 hours a month, and at most 1 hour per conversation. Deleted conversations still count. |
| Projects | 1. Sample projects do not count. Deleting the project frees the slot. |
| Recording project | One project takes recordings and uploads. "Use this project for recordings" switches it. |
| AI | A monthly AI allowance for every AI feature, shown as a percentage used. |
| Organisations | 1. You cannot create a second free organisation. |
| Workspaces | 1 on your organisation's plan. |
| People | No limit. |
| Agent (MCP) tool calls | 1,000 per calendar month per organisation. |

The limits cover all the workspaces of your billing account together. They start again on the
1st of each month (UTC). Workspace "Settings", "Usage and billing" shows "Free plan allowance",
with the audio you used, "AI this month" as "{percent}% used", and "Resets on {date}".

### The monthly AI allowance

Chat, the assistant, reports, maps, the analysis page, popcorn, canvas, Verify and Explore,
voice input, and the AI work on your recordings (transcripts, summaries, titles) all use one
monthly AI allowance. Voice input does not count toward your recording hours. Sample projects
use none of it.

- From 80% a banner shows on new chat, the report form, the map page and the allowance card:
  "You've used {percent}% of this month's AI. When it runs out, AI features and new recordings
  stop until {date}."
- AI that has started always finishes. A chat reply, a report or an analysis is never cut off
  halfway.

When the month's AI is used up:

- An AI action opens the upgrade popup: "This month's AI is used up". It names what you
  tried and the date AI comes back. Regenerating a conversation's summary or title is an AI
  action too, and so is clearing a summary.
- New recordings and uploads stop, and a recording that is going on stops, as when the hours
  run out (below). Audio already received is still transcribed. The project home and the
  conversations list say "This month's AI is used up. AI features and new recordings are paused
  until {date}.", and a refused upload says "This month's AI is used up. New recordings and
  uploads are paused until {date}." Plan a live event with this in mind: heavy chat use can
  stop your participants from recording.
- The assistant stops before its next step and says so. A run that starts after the budget ran
  out stops before it does anything.
- A scheduled report does not run and ends in error: "This month's AI budget is used up."
- Live popcorn goes back to manual. Start it again after the reset.
- Canvas updates on a schedule pause, and start again on their own after the reset.
- In the portal, Verify and Explore show "Not available right now", and finishing a recording
  no longer offers to verify. A participant who wants to type instead, or to add text to a
  finished conversation, sees "This project isn't taking responses right now." Someone typing
  when it runs out gets the same short grace as a recording. Participants never see anything
  about plans.
- "Give feedback" keeps working, voice included.
- Owners and admins get a notice and the email "{name} has used this month's AI budget".
- Nothing is locked. Every transcript, summary, report and map stays readable.

When the month's hours are used up:

- A recording that is going on stops. The participant reads "Recording has stopped for now.
  Everything you recorded is saved."
- The portal shows "This project isn't taking recordings right now." Uploads pause too.
- Nothing is locked. Every transcript and summary stays readable.
- Owners and admins get a notice and the email "{name} has used this month's recording hours".

The microphone in chat works on the free plan. It uses the AI allowance, not your hours.

> [!TIP]
> Planning a session longer than an hour, or more hours than you have left? Sort out your plan
> before the event. The way to a
> paid plan includes a call and an offer to sign, so it is not something to start during a
> recording.

## Seats

A seat is one person who holds the "Admin", "Member", "Billing" or "External" role in any
workspace of the billing account. Observers are free.

- A person is one seat per billing account, however many of its workspaces they are in.
- A workspace with its own plan counts its seats separately. The same person can hold a seat
  there and one on your organisation's plan.
- An invite is never refused because of a seat count. The one exception: while a plan is
  cancelled or past due, invites to paid roles are refused.
- A pending invite is not billed. It counts once it is accepted.

Add and remove people on each workspace's "Members" page. See
[managing your workspace](./managing-your-workspace.md).

## See your usage

| Where | What it shows | Who sees it |
|---|---|---|
| Workspace "Settings", "Usage and billing" | On the free plan, "Free plan allowance". Then this month's "Audio", "Seats", "Members", "Externals", "Observers (free)", "Pending invites" and "Projects" | "Admin", "Member", "Billing" |
| Organisation "Settings", "Usage" | "Organisation usage": one row per workspace with "Tier", "Hours", "Seats" and "Status" | Organisation admins and billing |
| A project's "Manage" menu, "Usage" | "Audio" and "Conversations" for the project, with a breakdown per conversation | People who can open the project |

Usage is counted per calendar month, and you can look back up to 12 months.

## What the billing page shows

Billing sits under workspace "Settings", "Usage and billing", and under organisation
"Settings", "Billing". What you see depends on how your plan is paid.

- On the free plan: "You are on the free plan. There is no payment to manage yet." and the
  button "Tell us what you need".
- A workspace on its organisation's plan: "Billing is managed by your organisation", with
  "Manage organisation billing".
- A paid plan with no payment set up in the dashboard: the badge "Arranged with dembrane".
- A plan that dembrane manages for you: the badge "Managed by dembrane", your seats, your
  account manager and your billing details. To change it, contact your account manager.
- A plan paid by card or SEPA Direct Debit: "Current plan", "Seats", "Next invoice", "Payment
  method", "Invoices", "Billing details" and "Cancel plan".

Invoices that follow a signed offer are not on this page. They are under your organisation's
"Documents".

If you pay by card or direct debit:

- Adding a person in the middle of a period adds a charge for the rest of that period.
  Removing a person gives no refund, but the seat stays paid until renewal and you can fill it
  again at no charge.
- When a charge fails, the plan stays active. The page shows "We couldn't charge your payment
  method" with "Try again" and "Change payment method".
- "Cancel plan" stops the renewal. You keep the plan until the period ends, then the account
  moves to Free. Until then "Resume plan" turns it back on.

Invoices and payment are for "Admin" and "Billing". A "Member" sees usage only.

## Move to a paid plan

There is no checkout, no plan picker and no upgrade request in the dashboard. This is the way:

1. Press "Tell us what you need". The button is on the billing page of a free account. The same
   link is in the popover that opens when you press a control your plan does not include.
2. A short screen says what you ran into and asks no questions. Press "Continue on
   dembrane.com", or "Maybe later" to close it. Everything you made stays as it is.
3. The pricing calculator on dembrane.com opens in a new tab. It asks how you use dembrane,
   which takes about two minutes, and you can book a short call with the dembrane team at the
   end. What you fill in there is linked to your dashboard account without your email being
   put in the link.
4. The offer arrives by email and under your organisation's "Documents" and "Tasks". It is
   valid for 14 days. An organisation admin or billing member signs it on screen, or sends it
   to someone else to sign. The data processing agreement comes with it as its own document.
5. Fill in your billing details. The invoice follows.

Signing the offer does not switch your plan by itself. The dembrane team sets the plan on your
account.

You can also write to support@dembrane.com to talk about what you need. For offers, signing
and invoices, see [offers and invoices](../../features/offers-and-invoices.md).

## If your plan goes down

When a plan moves down, the workspace shows a banner for 7 days and its admins and billing
members get a notice and an email.

- What you already made stays. Private projects, shares and private workspaces keep working,
  and existing webhooks keep firing. You cannot make new ones.
- A custom logo is removed.

## Related

- [Tiers and billing](../../features/tiers-and-billing.md): the full reference on plans.
- [Offers and invoices](../../features/offers-and-invoices.md): signing an offer, billing
  details, paying an invoice.
- [Managing your workspace](./managing-your-workspace.md): adding people, and what a seat is.
- [Roles and permissions](../../features/roles-and-permissions.md): who can see usage and
  invoices.
- [Getting help](./getting-help.md): how to reach the team.
