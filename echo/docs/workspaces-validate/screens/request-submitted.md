# Screen 3 — Request submitted (waiting)

**Intent:** give the user honest, bounded feedback after they submit something that completes asynchronously. Explicit SLA. Status visible. Request remains visible until resolved.

**Used by:** upgrade request, join request (request-to-join an open workspace), partner handoff pending, any other "you've asked, now we wait" moment.

**Reference:** matrix §6 (request-to-join approval), §11 (upgrade request to staff inbox), brief pattern 4.

---

## Shape

Two render modes — inline card and dedicated page, depending on context.

### Inline card (default)

```
┌──────────────────────────────────────────────┐
│  Request sent                                │
│                                              │
│  We'll get back to you within 1 business     │
│  day.                                        │
│                                              │
│  Request: Upgrade to innovator               │
│  Sent:    2026-04-23  10:42                  │
│                                              │
│  [Cancel request]                            │
└──────────────────────────────────────────────┘
```

- Replaces the submit form / modal on success. Does not dismiss or toast-and-vanish.
- Status indicator visible: `pending` (default), `approved`, `rejected`, `cancelled`.
- SLA: "within 1 business day" for upgrade requests; "your team admins will review" for join requests (no hard SLA since team admins are the humans in the loop).
- Primary affordance: "Cancel request" for upgrade requests. Join requests are uncancellable once sent — they simply expire.

### Dedicated page (rare)

For flows where the wait is the whole experience — e.g. partner handoff pending. User lands here from a link in the notification / email. Same content, full-width layout, no surrounding form chrome.

## Copy rules

- "Request sent." Not "Successfully submitted your request."
- Name the request subject concretely: "Upgrade to innovator", "Join {workspace}", "Become owner of {workspace}".
- SLA copy is honest. If we can't hit 1 business day, don't promise it.
- Never "Please wait." Never "Our team will get back to you shortly."
- If the request was silently rejected (matrix §6 member rejection), the card never moves off `pending` from the member's perspective — they find out by the lack of any notification. Don't fake acceptance.

## Status transitions

- **pending** → **approved**: notification fires, card updates to "Request approved on {date}." + CTA to go to the new access (e.g. `[Open {workspace}]`). Email mirror: approved-and-here's-the-link.
- **pending** → **rejected**: for admin-approvable requests (upgrade), card updates to "Request declined on {date}. Reason: {reason or empty}." CTA: `[Submit a new request]`.
- **pending** → **cancelled** (by requester): card removed; toast "Request cancelled."
- **pending** → **expired**: card updates to "Request expired." After a defined TTL (not this release — add when volumes warrant).

## Role awareness

- Requester sees the full card — their own request.
- Workspace admin / team admin sees the *incoming* request in a separate list (screen 5 manage-list), not this screen.
- Member-as-requester only exists for join requests (matrix §11 locks upgrade-request to admin/billing).

## Non-goals

- No progress bar — we don't know how long approval will take.
- No "ETA by {hour}" — we can't predict a human's calendar.
- No email reminder cron this release (brief anti-goal).
- No auto-cancel on workspace deletion — requests on a soft-deleted workspace simply become unreachable; don't add cleanup code.
