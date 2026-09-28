# Security holes: status on the platform

The holes of the old stack's access model (section 7 of the access spec, 2026-09-27) and the ones the
port introduced (N-), checked against this platform. Fixed means a route guard, a service check or
the access resolver refuses the exploit; gone means the surface no longer exists and no route reaches
that data without the check; open means the exploit still works.

Proof names a test in `apps/api/test/security/holes.integration.test.ts` (the whole API on a copy of
the parity template, run with `TEST_PARITY_ADMIN_URL`) unless it names another file, or a parity
scenario ("scenario: ..."). A parity `differs` only shows that the two sides disagree; the security
suite asserts the refusal itself.

## Critical and high

| id | severity | surface | status | proof |
|---|---|---|---|---|
| C-1 | critical | Directus `directus_users` writes (role, email, password, token, 2FA) | gone | C-1 |
| C-2 | critical | self email change plus invite auto-accept | fixed | C-2 |
| C-3 | critical | PATCH /api/projects/{A}/reports/{rid} | fixed | C-3; scenario projects-reports C-3 |
| C-4 | critical | POST /api/projects/{A}/conversations/{cid}/tags/delete | gone | C-4; scenario "projects conversation tags delete: removed" |
| C-5 | critical | DELETE /api/projects/{id} | fixed | C-5 |
| C-6 | critical | Directus `conversation_reply` public read and write | gone | C-6; portal.integration "replies: ... own project" |
| C-7 | critical | Directus `project_report_notification_participants` | gone | C-7 |
| H-1 | high | PUT /api/verify/topics/{pid} | gone | H-1; scenario "verify select: removed" |
| H-2 | high | POST /api/verify/generate, PUT /api/verify/artifact/{aid} | open | H-2 (bindings); see N-5 |
| H-3 | high | DELETE /api/projects/{A}/tags/{tag} | fixed | H-3 |
| H-4 | high | POST /api/chats/{id}/add-context | fixed | H-4 |
| H-5 | high | GET /api/participant/projects/{pid}/conversations/{cid}(/chunks) | fixed | H-5 |
| H-6 | high | POST /api/stateless/transcribe audio_file_uri | fixed | H-6; stateless.integration "URLs and keys outside the project are refused (H-6)" |
| H-7 | high | POST /api/participant/conversations/{cid}/confirm-upload | fixed | H-7 |
| H-8 | high | project reads by workspace billing | fixed | H-8 |
| H-9 | high | report delete and cancel-schedule | fixed | H-9 |
| H-10 | high | POST /api/conversations/{cid}/get-reply | open | H-10 (deleted, closed, forged token, rate limit); see N-5 |
| H-11 | high | popcorn public setting, present publish | fixed | scenarios popcorn-controls and present-draft H-11 |
| H-12 | high | workspace member PATCH and DELETE on an owner | fixed | H-12 |
| H-13 | high | support access lifecycle | fixed | H-13; staff.integration "join, extend and timed revoke" |
| H-14 | high | blanket staff access | fixed | H-14 |
| N-5 | high | participant token never enforced | open | none (config) |

## Medium and low

| id | severity | surface | status | proof |
|---|---|---|---|---|
| M-1 | medium | verify custom topics | fixed | scenarios "verify custom create: observer refused" |
| M-2 | medium | participant chunk delete | fixed | scenario "portal chunk delete: another conversation's chunk" |
| M-3 | medium | ping body project_id into the monitor | fixed | M-3; scenario "monitor: a foreign conversation pinged under this project stays out" |
| M-4 | medium | project detail and usage for billing | fixed | H-8; resolve.test "workspace billing users get no project data" |
| M-5 | medium | home search for billing | fixed | scenario "search: workspace billing role" |
| M-6 | medium | hardcoded admin checks, support sessions | fixed | resolve.test "an approved session acts as admin but never on consent, members or deletion" |
| M-7 | medium | `fields` passthrough | fixed | scenarios conversations-bff M-7 |
| M-8 | medium | report content edits | fixed | scenario "reports update: observer cannot edit content" |
| M-9 | medium | org usage | fixed | scenario "org usage: plain member sees only workspaces they reach" |
| M-10 | medium | private chats | fixed | scenarios chat-v1 and chat-bff M-10 |
| M-11 | medium | report views, needs-update, progress | fixed | scenarios projects-reports M-11 |
| M-12 | medium | project pin | fixed | scenarios projects M-12 |
| M-13 | medium | agent workspace memory | fixed | scenarios chat-agentic-data M-13 |
| M-14 | medium | workspace self-join | fixed | M-14; scenario "join: org admin into a private workspace" |
| M-15 | medium | data ownership | fixed | M-15 |
| M-16 | medium | billing route roles | fixed | billing routes.test M-16 |
| M-17 | medium | invoice PDF | fixed | billing service.test "a sales invoice PDF is only served for the account it was issued to" |
| M-18 | medium | revocation on suspend | fixed | scenario agent-rest "suspended person"; N-2 |
| M-19 | medium | participant writes | open | M-19 (subscribe bound and capped); source and finish wait on N-5 |
| M-20 | medium | custom policies | fixed | policies.test "custom policies only add known policies" |
| M-21 | medium | DISABLE_CORS | gone | fixed origin list in apps/api/src/app.ts |
| M-22 | medium | webhook SSRF | fixed | webhooks.test M-22; N-4 |
| L-1 | low | Directus junction and translation rows | gone | no route exposes the tables |
| L-2 | low | agentic runs of removed users | fixed | code: agentic/src/runs/service.ts authorizeRun |
| L-3 | low | body ids trusted | fixed | scenarios chat-agentic-data L-3 |
| L-4 | low | analysis runs and picker | fixed | resolve.test (project:read) |
| L-5 | low | client-set message_from | open | none |
| L-6 | low | foreign ids attached | fixed | scenarios projects-goals and conversations-portal L-6 |
| L-7 | low | methodology visibility | fixed | scenario projects-goals L-7 |
| L-8 | low | share token rotation | fixed | scenarios popcorn-controls and present-draft L-8 |
| L-9 | low | direct membership queries | fixed | scenario "support session: an expired grant gives no access" |
| L-10 | low | external as org admin | fixed | scenario tenancy-orgs L-10 |
| L-11 | low | guest org removal | fixed | scenario tenancy-orgs L-11 |
| L-12 | low | private project names in lists | fixed | code: tenancy/src/service/projects.ts |
| L-13 | low | duplicate shares | fixed | scenario tenancy-access L-13 |
| L-14 | low | invite reactivation | fixed | L-14 |
| L-15 | low | soft-deleted org | fixed | code: tenancy/src/service/orgs.ts |
| L-16 | low | resend by demoted inviter | fixed | scenario "resend: an inviter without member:invite is refused" |
| L-17 | low | legacy tiers | fixed | scenarios staff and tenancy-workspaces L-17 |
| L-18 | low | MCP dynamic registration | open | rate limit keyed on spoofable X-Forwarded-For (N-7) |
| L-19 | low | refresh reuse | fixed | scenario mcp-oauth L-19 |
| L-20 | low | IP limits trust X-Forwarded-For | open | see N-7 |
| L-21 | low | public reports of deleted projects | fixed | scenarios conversations-reports L-21 |
| L-22 | low | unauthenticated verify reads | open | see N-5 |
| L-23 | low | uploads to public folders | fixed | scenario account-settings L-23; N-3 |
| L-24 | low | agent docs regex, project read, issue ids | fixed | scenarios agent-rest L-24 |
| L-25 | low | dead pilot and seat gates | gone | not ported |
| L-26 | low | dead policy code | fixed | scenarios tenancy L-26 |
| L-27 | low | cookie and default role config | gone | auth.ts secure cookies outside local and test |

## Introduced by the port

| id | severity | surface | status | proof |
|---|---|---|---|---|
| N-1 | medium | staff API key: every staff permission, expiry slides forever | fixed | N-1 (scope, hard expiry) |
| N-2 | low | suspended or archived user keeps live sessions | fixed | N-2 |
| N-3 | low | /api/assets/:id serves stored HTML inline on the API origin | fixed | N-3 |
| N-4 | medium | webhook and demo fetch: IPv4 inside IPv6 passes the private check | fixed | webhooks.test M-22 |
| N-5 | high | PARTICIPANT_TOKEN_REQUIRED is off everywhere and the portal never sends the token | open | none |
| N-6 | medium | Better Auth rate limits fall into one shared bucket behind the proxy | open | none |
| N-7 | medium | app rate limits and e-sign evidence take the first X-Forwarded-For hop | open | none |
| N-8 | low | webhook DNS rebinding between the check and the fetch | open | none |
| N-9 | low | a named signer can be any address and re-pointed silently | open | none |

## Open, with the exploit and the fix

- N-5, H-2, H-10, M-19, L-22 (high): a bare conversation UUID still works as the participant's capability, because the token check passes when no token is sent. Exploit: whoever holds a conversation id gets verify summaries of its transcript, spends replies (20 a minute), finishes it, or reads verify artifacts. Fix: the portal stores the `x-participant-token` from initiate and sends it on every participant call, the iOS app too, then `PARTICIPANT_TOKEN_REQUIRED=true` in next and prod.
- N-6 (medium): behind the web proxy X-Forwarded-For has two or more hops, Better Auth trusts none of them and keys every caller on one bucket per path. Exploit: three sign-in requests every 10 seconds lock everyone out of password sign-in and code sign-in. Fix: `advanced.ipAddress.trustedProxies` set to the hops Cloud Run and the web proxy add, and a database rate-limit store instead of per-instance memory.
- N-7, L-18, L-20 (medium): registration, invite status, MCP client registration, report sign-up, pings, stats, popcorn public and the e-sign evidence IP read the first X-Forwarded-For hop, which the client sets. Exploit: a random header per request removes every IP limit and forges the signer's recorded IP. Fix: one `clientIp()` in @dembrane/http that takes the rightmost hop not in a trusted list, and the web proxy sets the header instead of passing the client's through.
- N-8 (low): the webhook target is resolved for the check and again by fetch. Exploit: a DNS name that answers public first and private second. Fix: connect to the checked address with the original Host header.
- N-9 (low): any holder of account:sign names any address as signer, which then may receive sign-in codes, and can replace a named signer without a trace. Fix: rate limit naming per org, record a replaced signer in the account timeline.
- L-5 (low): a chat member can store a message as "assistant" in their own chat. Fix: store the streamed reply server side and refuse "assistant" from clients.
