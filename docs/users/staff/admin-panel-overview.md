---
title: The staff console
description: Where the dembrane staff console is, what each section is for, how the actions on an account and a workspace are laid out, and what is recorded.
audience: staff
---

# The staff console

The staff console is at `/admin` in the dashboard. You use your normal sign-in. Open it with
"Staff" in the user menu or "Admin dashboard" in the sidebar. The screen is titled "Admin".

Someone who is not staff sees "Staff only" and the line "This area is for dembrane staff. If you
think you should have access, email support@dembrane.com." Staff access is given to dembrane
employees by dembrane's engineers, and no screen in the product can grant it.

## The sections

| Section | What you do there | Guide |
|---|---|---|
| "Usage and billing" | See every billing account for a month: tier, hours, seats and forecast. Open the actions on an account or a workspace. | [Usage, billing and payments](./usage-and-billing-rollup.md) |
| "Payments" | Follow recent card and direct debit payments across all accounts. | [Usage, billing and payments](./usage-and-billing-rollup.md#payments) |
| "Accounts" | Run a customer account: the demo, the offer, documents to sign, tasks and questions. | [Customer accounts](./customer-accounts.md) |
| "Training" | Schedule trainings and grant licences. | [Trainings and licences](./trainings-and-licences.md) |
| "Response feedback" | Read the thumbs that hosts give on chat replies. | [Response feedback](#response-feedback) |

"Managed billing" has no sidebar entry. Open it at `/admin/managed-billing`. See
[managed billing](./managed-and-offline-billing.md).

## Actions on an account and on a workspace

Most changes start on "Usage and billing". Each row there is one billing account.

- The three-dot button at the end of a row opens the account actions.
- Expand the row to see its workspaces. Each workspace has its own three-dot button for the
  workspace actions.

| Where | What is in it |
|---|---|
| Account actions | "Partner organisation" (on an organisation account), "Change tier", "Billing mode", "Discount", and "Workspaces in this account" with a "Workspace actions" button for each. |
| Workspace actions | "Join for support". For a workspace billed on its own account: also "Change tier" and "Billing mode". |

A workspace on its organisation's plan has no tier of its own. Its workspace actions say: "This
workspace shares its organisation's billing. Change the tier from the organisation account, where
it applies to every internal workspace in the org."

Where each action is explained:

- "Change tier", "Discount" and "Partner organisation": [tiers and discounts](./discounts-trials-and-tiers.md).
- "Billing mode": [managed billing](./managed-and-offline-billing.md).
- "Join for support": [support access](./support-access.md).

> [!WARNING]
> These actions take effect at once and the customer sees most of them. The tier screen says it
> plainly: "A downgrade limits features immediately."

## What is recorded, and what you cannot see

Every staff action is written to an audit trail before it runs.

The console does not open a customer's projects, conversations or reports. For that you need a
[support session](./support-access.md), and only the customer can allow one.

## Response feedback

Hosts can give a chat reply a thumbs up or a thumbs down. "Response feedback" lists those
ratings with "Date", "Rating", "Question" and "Organisation".

- Filter with "Rating", "Reason", "Mode" and "Date range".
- Open a row to read "Host's feedback" (their comment) and "Conversation": the question they
  asked and the reply they rated.

A thumbs down asks the host for a reason and tells them: "Your feedback and this response go to
the dembrane team."

## Related

- [For staff](./index.md): every staff job and its page.
- [Usage, billing and payments](./usage-and-billing-rollup.md): the screen you start from.
- [Support access](./support-access.md): the only way into a customer's workspace.
- [Chat and Ask](../../features/chat-and-ask.md): where hosts give the thumbs you read here.
- [Roles and policies in code](../developer-internal/roles-and-policies.md): the staff permissions, for engineers.
