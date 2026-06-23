# Sharing to team plan

The goal: capture the business moments we currently can't see, so we can answer basic questions like "where did this customer come from?", "of everyone who scans a QR, how many actually contribute?", and "how long does a host wait for their summary?". Today a lot of this is invisible to us.

Two foundations make the numbers trustworthy:

- A proxy so ad blockers stop quietly eating our data (we lose an estimated 10-30% today).
- Recording the highest-value moments on our servers, not just in the browser, so they can't be blocked or lost (a payment clearing, a conversation finishing, a summary landing).

Read it and tell me what's missing. What would you want to know that you can't see today?

## Website -> Dashboard funnels

- Marketing site -> dashboard. Connect a website visitor to the account they later create, so we can see which traffic turns into real hosts.
- "Get in touch" (Tally) -> signup. Today the form lives in Tally and never reaches our analytics, so a website inquiry is disconnected from who signs up. This is the real top of the sales funnel while we're invoiced.
- Registration. Landed -> filled details -> account created. We'll confirm the account on the server side too, so ad blockers can't hide signups.
- Onboarding. Questionnaire completed, plus the role and intent they told us (whether they work with clients).
- Invitations. Invite sent -> email delivered -> opened -> accepted -> active member. We're almost completely blind here today, so we can't see where invites fall apart.
- Workspace creation. Started the wizard -> chose internal team vs external client -> switched back and forth -> created. The "switched back" moment answers "how many people backtrack from external to internal?".
- Buying intent. Hit a paywall, opened billing, or clicked "Book a call". We have both paths already: self-serve checkout exists, and gated features open a booking link. Since we invoice everyone today, these intent signals are what should feed sales, more than self-serve checkout.

## Portal

- The journey funnel. Landed -> gave consent -> started recording or upload -> finished -> saw their report. This gives us the one number we most lack: of everyone who scans, how many actually contribute.
- Source attribution at landing. Tag every way a link goes out (scanned QR, clicked QR, copied link, downloaded QR, host guide, report, from inside the portal) so we can split "how many came from a QR vs a link vs the printed guide" the instant anyone lands.
- Conversation finish: explicit vs automatic. Did the host or participant actually press finish, or did our system close an abandoned conversation for them? Tells us whether the finish step is even discoverable.
- Finish -> summary time. How long a host waits between recording ending and their summary appearing. This is their perceived wait, and we have zero visibility into it today.
- Verify usage and regenerate. Whether the verify step gets used, and how often people regenerate. A proxy for how good the first result is.
- Explore usage and rate limiting. How much explore and deep-dive get used and, critically, how often people slam into a limit. Both a quality and a packaging signal.
- Portal recording errors. Recording failures are silent lost data today. We want a real error rate, not one-off reports.

## A note on privacy

Portal participants are anonymous and the tool handles sensitive input. Portal tracking should be event-only (no session recording) and run past whoever owns privacy first.
