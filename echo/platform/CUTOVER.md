# Production cutover: old stack to the platform

Moves dembrane prod from the old stack (Python API, Directus and Dramatiq workers on
DigitalOcean Kubernetes, DO managed Postgres, DO Spaces) to the platform (Cloud Run, Cloud SQL,
GCS and DBOS in `dembrane-web-prod`, europe-west4). The scripts live in `ops/`; each one reads
the old stack and refuses to write to it.

Window: **Saturday 3 October 2026, 08:00 to 12:00 CEST**, Sunday 4 October same hours as the
fallback. Saturday 09:00 to 11:00 is among the quietest weekend hours for recordings on prod
(90 days of chunks: 64 and 52 per hour against 2,413 at 15:00), and Saturday leaves Sunday to
recover.

Expected downtime: **about 75 minutes**, budgeted at 2 hours, from the old API going down to the
DNS switch. The rest of the window is reserve for a rollback.

## Roles

| Role | Who | Does |
|---|---|---|
| Lead | CTO | Go and no-go calls at the gates, DNS, approves every outward message |
| Operator | Sameer | Runs the steps, reads out each verification |
| Second | one more engineer | Watches the old and new dashboards, alerts and the support inbox, keeps the timing log |

Every step below names its owner, its start time relative to T (the freeze, 08:00), its measured
or extrapolated duration, and the check that must pass before the next step.

## Numbers this plan rests on

Prod, read-only on 2026-09-28:

- Postgres: 42 GB. 21 GB is the dead tables the contract migration drops (LightRAG, the old
  library's segments), archived before the window and never copied. 19 GB is Directus's audit
  history (`directus_revisions`, `directus_activity`), which nothing in the platform reads; it
  stays in the frozen DO database and is archived before DigitalOcean is shut down. What moves
  in the window is **4.8 GB of rows** (4.4 M rows, 0.56 GB of indexes), and one table,
  `conversation_chunk` at 3.5 GB, sets the pace because pg_dump copies a table on one stream.
- Spaces: **2.88 M objects, 9.88 TiB** in `dbr-echo-prod-uploads`, of which 8.65 TiB
  (711 k objects under `conversation_id/`) is 2025 segment audio of the old library, written May
  to October 2025, with no writer since and no reference from any row the platform keeps; it
  belongs with `conversation_segment`, which the contract migration drops. It stays in Spaces
  (decision at W12). What moves is **1.24 TiB in 2.17 M objects** (`conversation/` 0.78 TiB,
  `audio-conversations/` 0.21, `audio-chunks/` 0.18, `chunks/` 0.06, avatars and images), in the
  days before; the window copies only what rows written since the last pass reference.
- 744 users (500 active); 3 with two-factor (zaltbommel.nl, flyingelephants.nl, dembrane.com);
  10 project webhooks; 7 registered MCP clients with 4 live grants; 2,781 chunks in the last 24 h.

Rehearsal on a copy of echo-next (2026-09-28, 1 GB database, 23,383 objects, 41.6 GiB), dump and
restore run from an office connection, restore into a scratch database on a 1 vCPU Cloud SQL
instance, the API as a temporary Cloud Run service:

| Step | echo-next, measured | prod, extrapolated | Basis |
|---|---|---|---|
| Dump (8 jobs, production set) | 18 s for 241 MB | 7 to 10 min | one stream at 8.6 MB/s or more over `conversation_chunk` |
| Restore (4 jobs) | 24 s | 8 to 15 min | 10 MB/s per stream on 1 vCPU; prod has 2 vCPU |
| ANALYZE | 3 s | 1 min | samples a fixed number of rows per table |
| Archive record | 10 s | 2 min | counts on the frozen source |
| Migrate job | 11 s | 2 min | 132 users synced; prod 744, plus job start |
| Verify database | 12 s | 5 min | 4.4 M rows counted, one scan per table for the sample |
| File delta (manifest) | 57 s for 1,246 keys | 2 to 3 min | about 350 new chunks in 3 hours |
| Verify file delta | 9 s | 1 min | per-key lookups |
| Deploy | 21 s per service | 5 min | services roll in parallel |
| Smoke tests | 2 s | 2 min | plus reading the results |
| Full file pass, nothing to copy | 56 s for 23 k objects | about 50 min | listing at 750 objects/s over 2.17 M; runs after the switch |
| File pre-sync | 98 MB/s average, 380 MB/s peak, 49 objects/s, one VM with 8 agents | 4 to 12 h on one VM, 2 to 5 h on three | 1.24 TiB by bytes, 2.17 M objects by count |

The dump and restore numbers come from an office line and a smaller instance, so they are an
upper bound; the T-1 dry run (step P7) measures them on the real path and replaces this table's
prod column before the go decision.

## Before the window

### P1. Infrastructure applied in dembrane-web-prod (owner: Lead, by Tuesday 29 Sep 18:00)

The infra branch (`infra/projects-split`) applies foundations and data stores for prod. The
cutover needs, in the prod project:

- Cloud SQL `echo-prod` (Postgres 16, `db-custom-2-8192`, regional), database `echo` empty,
  logins `echo_owner` and `echo_app`, and the flag `maintenance_work_mem` at 1 GB (index builds
  in the restore). Nothing may run migrations against it before step W5: the restore expects an
  empty database.
- Bucket `dembrane-web-prod-echo-prod-uploads`, versioned, EU, with the dashboard and portal CORS.
- Bucket `dembrane-web-prod-echo-archive` (EU, no public access, retention lock 1 year) for the
  contract archive, the Directus audit archive and the transfer manifests. It is the scripts'
  default `ARCHIVE_DEST`.
- Storage Transfer: API `storagetransfer.googleapis.com` enabled, agent pool `echo-cutover`,
  service account `echo-cutover-transfer` with `roles/storagetransfer.transferAgent` on the
  project, `roles/storage.objectAdmin` on the uploads bucket and `roles/storage.objectViewer` on
  the archive bucket; the Storage Transfer service agent with `roles/storage.admin` on the
  uploads bucket, `roles/storage.objectViewer` and `roles/storage.legacyBucketReader` on the
  archive bucket (it reads manifests there), and `roles/storagetransfer.serviceAgent` on the
  project. Secret `echo-cutover-spaces` holding the prod Spaces keys as `AWS_ACCESS_KEY_ID=` and
  `AWS_SECRET_ACCESS_KEY=` lines, readable by `echo-cutover-transfer`.
- Secrets, values copied from the old prod (`secret-manager.sh prod get <KEY> --live`), names only:
  `INVITE_HASH_SECRET` = Directus `SECRET` (keeps Directus-era invite links and every registered
  MCP client secret valid), `ECHO_SUPPORT_WEBHOOK_TOKEN` (the website needs form and sam
  forwards), `SUPPORT_WEBHOOK_URL`, `SENDGRID_API_KEY`, `AUTH_GOOGLE_CLIENT_ID`,
  `AUTH_GOOGLE_CLIENT_SECRET`, `MOLLIE_API_KEY`. Leave `SITE_API_TOKEN` unset.
- A global external HTTPS load balancer in front of the API, dashboard and portal services with
  Certificate Manager certificates for `api`, `dashboard`, `portal` and `directus.dembrane.com`,
  authorised by DNS (CNAME records in Cloudflare) so they are issued before any traffic moves.
  URL map for `directus.dembrane.com`: `/assets/*` rewritten to `/api/assets/*` on the API (old
  email images and stored avatar links keep working), everything else a 301 to
  `https://dashboard.dembrane.com/login`.
- A prod deploy path (workflow or `scripts/deploy-env.sh prod`) that deploys the migrate job
  **without executing it**, and the worker pool at 0 instances until W5 is done. The preview
  flow's `--execute-now` against an empty prod database would build a fresh schema that the
  restore then has to throw away.
- Alerts in `monitoring.tf` for prod: API 5xx ratio above 2% over 5 min, p95 latency above 2 s
  over 10 min, worker pool not running, DBOS queue age above 10 min, Cloud SQL CPU above 80%
  over 10 min, uptime checks on the four hostnames. Notification channel: the ops Slack channel.

Verify: `terraform plan` for prod is empty; `gcloud sql instances describe echo-prod` says
RUNNABLE; the certificates are ACTIVE; `gcloud storage buckets describe` finds both buckets.

### P2. Transfer VMs and the file pre-sync (owner: Operator, start Wednesday 30 Sep 09:00)

The office uplink moves about 5 MB/s, which would take days; agents in europe-west4 moved
98 MB/s on average in the rehearsal. Three VMs share one agent pool, so the small objects
under `conversation/` (median 0.5 MB) do not bound the copy by count.

```sh
cd echo/platform
export PROJECT=dembrane-web-prod AGENT_POOL=echo-cutover SPACES_SECRET=echo-cutover-spaces \
  SA=echo-cutover-transfer@dembrane-web-prod.iam.gserviceaccount.com
for n in 1 2 3; do VM=echo-cutover-transfer-$n ops/transfer-agents.sh up; done
export JOB=transferJobs/echo-cutover-prod SOURCE_BUCKET=dbr-echo-prod-uploads \
  SINK_BUCKET=dembrane-web-prod-echo-prod-uploads EXCLUDE_PREFIXES=conversation_id/
ops/files-sync.sh create
STEP=files-presync ops/files-sync.sh run
```

Verify: the job ends SUCCESS with `objectsFromSourceFailed=0`. If objects fail with 412, run the
pass again (the rehearsal saw ten after agents were swapped mid-run; the rerun cleared them).
Then `bun ops/verify-files.ts --exclude conversation_id/` (full listing, about 15 minutes)
reports 0 missing.

Watch DigitalOcean: 1.24 TiB of egress from Spaces is above the included transfer and is billed.

### P3. Contract archive (owner: Operator, Wednesday 30 Sep)

Dumps the 16 tables the contract migration drops (20.6 GB, largest 11.8 GB) from the old
database, read-only, one table at a time. About 40 minutes.

```sh
SOURCE_URL=<old prod direct URL, port 25060> ARCHIVE_DEST=gs://dembrane-web-prod-echo-archive/contract \
  ops/archive.sh pre
```

Verify: the last line prints `ARCHIVE_PREFIX=...`; write it in the timing log. `manifest.tsv`
lists all 16 tables with row counts (8 LightRAG tables on prod only).

### P4. Hostnames and outside consumers (owner: Lead, Thursday 1 Oct)

- Cloudflare: TTL 60 s on `api`, `directus`, `dashboard`, `portal` (all DNS-only today; api and
  directus are A records to the DO load balancer, dashboard and portal CNAMEs to Vercel). Note
  the current values in the timing log: they are the rollback.
- Google OAuth client: add `https://api.dembrane.com/api/auth/callback/google` as a redirect URI.
- Keep the Vercel projects and their domains exactly as they are; they are the rollback for
  dashboard and portal.
- Mint sam's staff key on the prod database after W5 (step W12); prepare the sam change now: in
  `src/utils/pricing_enquiries_digest.py`, `fetch_rows` calls
  `GET https://api.dembrane.com/api/v2/admin/pricing-configurations?days=7` with
  `Authorization: Bearer <staff key>` instead of psql against DO. The response is the same list of
  rows the digest builds from; `DIGITALOCEAN_ACCESS_TOKEN` and `CLUSTER_ID` can go afterwards.
- Customer notice (draft at the end): the Lead decides whether and when it goes out. Two working
  days ahead, so no later than Thursday 1 Oct.

### P5. Operator VM (owner: Operator, Thursday 1 Oct)

The dump and restore run from a VM in europe-west4, next to Cloud SQL, not from the office.
Debian 12, `n2-standard-8`, 100 GB pd-ssd, service account with `roles/cloudsql.client`, Docker,
Bun, `cloud-sql-proxy` and a checkout of the branch with `ops/`. The proxy runs on 127.0.0.1:5432
to `dembrane-web-prod:europe-west4:echo-prod`.

### P6. Daily file passes (owner: Operator, Thursday and Friday)

`STEP=files-presync ops/files-sync.sh run` once a day. Each pass copies only new objects (about
65 k objects, 43 GiB a week) and takes about 50 minutes of listing.

### P7. Dry run on the real path (owner: Operator, Friday 2 Oct 20:00)

Measures the numbers this plan extrapolates and catches prod-only surprises, without touching
prod's `echo` database:

```sh
gcloud sql databases create echo_dryrun --instance echo-prod --project dembrane-web-prod
SOURCE_URL=<old prod direct URL> TARGET_URL=postgres://echo_owner:<pw>@127.0.0.1:5432/echo_dryrun \
  DUMP_DIR=/data/dryrun TIMINGS=/data/dryrun.tsv JOBS=8 ops/db-move.sh all
TARGET_URL=... SOURCE_URL=... ops/archive.sh record <ARCHIVE_PREFIX>
MIGRATION_DATABASE_URL=postgres://echo_owner:<pw>@127.0.0.1:5432/echo_dryrun APP_ENV=prod \
  APP_DB_ROLE=echo_app bun apps/migrate/src/main.ts
SOURCE_URL=... TARGET_URL=.../echo_dryrun bun ops/verify-db.ts
gcloud sql databases delete echo_dryrun --instance echo-prod --project dembrane-web-prod
rm -rf /data/dryrun
```

The dump reads prod with a read-only session while customers use it; the old database has 2
vCPU, so run it in the evening. Also run W1's queue-length one-liner once in a worker pod: it
reads Valkey and proves the command works before it matters. Record every duration in the timing log and update the prod
column above. **No-go** if dump plus restore exceeds 45 minutes or verify reports a mismatch.

Last pass: `STEP=files-presync ops/files-sync.sh run` starting Saturday 05:00; note its
`startTime`: minus one hour, it becomes `SINCE` in W7.

## The window

Times are from T = 08:00. The Second keeps `ops/.timings.tsv` (written by the scripts) and a
hand log of every manual step.

### W0. Go (T-15, Lead)

Verify: P1 to P7 done; the last file pass ended SUCCESS; the dry run was inside its budget;
the new services are deployed and healthy on their run.app URLs against nothing (worker pool at 0);
old prod healthy (so a rollback returns to a known state). Lead says go.

### W1. Freeze the old stack (T+0, Operator, 15 min)

The old stack has no maintenance mode, so the freeze stops the doors first, drains the queues,
then makes the database read-only.

```sh
K="kubectl --context do-ams3-dbr-echo-prod-k8s-cluster -n echo-prod"
# Argo would put every replica back: turn self-heal off first.
kubectl --context do-ams3-dbr-echo-prod-k8s-cluster -n argocd patch application echo-prod \
  --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}'
# The doors: API and Directus. HPAs have minimums (API 6, Directus 2), so they go first.
$K delete hpa echo-api-hpa echo-directus-hpa
$K scale deploy/echo-api deploy/echo-directus --replicas=0
# Nothing new is scheduled.
$K scale deploy/echo-worker-scheduler deploy/echo-worker-ticks deploy/echo-agent --replicas=0
```

Drain (up to 10 minutes): the workers finish what is queued (transcriptions, webhook
deliveries, summaries). The prod Valkey is on DO's private network, so read the Dramatiq queues
from inside a worker pod (each queue is a list of message ids beside a `.msgs` hash; `.DQ` is the
delay queue):

```sh
DQ='import os, redis; r = redis.from_url(os.environ["REDIS_URL"]); print({q: r.llen("dramatiq:" + q) for q in ["network", "cpu", "network.DQ", "cpu.DQ"]})'
$K exec deploy/echo-worker -- python -c "$DQ"
```

At zero, or at T+12 whatever is left, save the leftovers for replay by hand, then stop the workers:

```sh
$K exec deploy/echo-worker -- python -c 'import os, json, redis; r = redis.from_url(os.environ["REDIS_URL"]); print(json.dumps({q: {k.decode(): v.decode() for k, v in r.hgetall(f"dramatiq:{q}.msgs").items()} for q in ["network", "cpu", "network.DQ", "cpu.DQ"]}))' > /data/dramatiq-leftover.json
$K delete hpa echo-worker-hpa echo-worker-cpu-hpa
$K scale deploy/echo-worker deploy/echo-worker-cpu --replicas=0
```

Read-only, as `doadmin` on the old database:

```sql
ALTER DATABASE defaultdb SET default_transaction_read_only = on;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = 'defaultdb' AND pid <> pg_backend_pid() AND usename <> 'postgres';
```

Verify: `kubectl get deploy` shows 0 of 0 everywhere except neo4j; `https://api.dembrane.com/api/v2/me`
answers 503; a new session's `SHOW default_transaction_read_only` is `on`;
an `INSERT` in a new session fails with "cannot execute INSERT in a read-only transaction". Record the time:
this is when downtime starts.

### W2. Data move (T+15, Operator, 20 to 25 min)

On the operator VM:

```sh
export SOURCE_URL=<old prod direct URL, port 25060> \
  TARGET_URL=postgres://echo_owner:<pw>@127.0.0.1:5432/echo \
  DUMP_DIR=/data/cutover/dump TIMINGS=/data/cutover/timings.tsv JOBS=8
ops/db-move.sh all
```

Verify: the three steps log `done`; `psql "$TARGET_URL" -c 'select count(*) from conversation_chunk'`
is non-zero. A failed restore is safe to repeat with `RESET_TARGET=1 ops/db-move.sh restore`; the
dump is reused.

Why pg_dump and not Database Migration Service: 4.8 GB moves in about 20 minutes this way, with the
tables we do not want left behind by one flag. DMS would need pglogical and a replication user on
the DO database (a change to the old stack), would copy all 42 GB including the 40 GB we leave
behind, and wants its own destination instance where Terraform already owns ours. Its gain,
continuous replication, would cut perhaps 15 minutes; not worth a second moving part this week.

### W3. Contract archive recorded (T+40, Operator, 2 min)

```sh
ops/archive.sh record <ARCHIVE_PREFIX from P3>
```

Verify: every table logs `matches`; the last line says `recorded ... for 0012_contract_dead_features`.
If a count moved, something still wrote a dead table: run `ops/archive.sh pre` now (40 min, the
downtime grows) and record the new prefix.

### W4. Migrate job: schema, identity sync, grants (T+42, Operator, 2 min)

```sh
gcloud run jobs execute echo-prod-migrate --project dembrane-web-prod --region europe-west4 --wait
```

It adopts the baseline, applies 0002 to 0012 (0011 creates the analysis, map and overage tables
prod never had; 0012 drops the archived tables), creates the DBOS schema, copies every Directus
user into Better Auth with the same id, password hash and Google link, seeds the legal texts and
grants `echo_app` data rights.

Verify: the job log has `schema migrated` with `adoptedBaseline: true`, `identities synced` with
`users` equal to the old `directus_users` count (744), and `migration job complete`. A
`ContractArchiveMissing` error means W3 did not record: nothing was applied; fix and rerun.

### W5. Verify the database (T+45, Operator, 5 min)

```sh
bun ops/verify-db.ts --json /data/cutover/verify-db.json
```

Verify: exit 0. Expected in its report: `excluded` for the Directus audit and dead tables,
`dropped` for the 16 archived tables, `new` for the platform's tables. Any `MISMATCH` is a
no-go: roll back (R1).

### W6. Start the workers (T+50, Operator, 2 min)

Scale the worker pool to its prod size (4). DBOS picks up nothing old: the Dramatiq queue did
not move. Verify: the worker log shows the executor heartbeat.

### W7. File delta (T+50, Operator, 5 min, in parallel with W6)

```sh
TARGET_URL=... SINCE=<last pass startTime minus 1 hour> \
  MANIFEST=gs://dembrane-web-prod-echo-archive/manifests/window.csv ops/files-manifest.sh
JOB=transferJobs/echo-cutover-prod-delta MANIFEST=gs://dembrane-web-prod-echo-archive/manifests/window.csv \
  SOURCE_BUCKET=dbr-echo-prod-uploads SINK_BUCKET=dembrane-web-prod-echo-prod-uploads \
  AGENT_POOL=echo-cutover STEP=files-delta ops/files-sync.sh run
SPACES_KEY=... SPACES_SECRET=... SOURCE_BUCKET=dbr-echo-prod-uploads \
  SINK_BUCKET=dembrane-web-prod-echo-prod-uploads GCS_TOKEN="$(gcloud auth print-access-token)" \
  bun ops/verify-files.ts --manifest gs://dembrane-web-prod-echo-archive/manifests/window.csv
```

Verify: the transfer ends SUCCESS; verify reports 0 missing and 0 differing. The platform reads
files only through these rows, so this is everything the switch needs; the full pass after the
switch (W11) picks up anything no row references.

### W8. Smoke tests through the new load balancer (T+55, Operator and Second, 10 min)

On the operator's laptop, point the four names at the load balancer for this test only:

```sh
sudo sh -c 'printf "%s api.dembrane.com dashboard.dembrane.com portal.dembrane.com directus.dembrane.com\n" <LB IP> >> /etc/hosts'
API_URL=https://api.dembrane.com DASHBOARD_URL=https://dashboard.dembrane.com \
  PORTAL_URL=https://portal.dembrane.com DIRECTUS_URL=https://directus.dembrane.com \
  SMOKE_EMAIL=$DEMBRANE_QA_PROD_EMAIL SMOKE_PASSWORD=$DEMBRANE_QA_PROD_PASSWORD \
  TARGET_URL=<read-only URL> SITE_TOKEN=<ECHO_SUPPORT_WEBHOOK_TOKEN> \
  EXPECT_ISSUER=https://api.dembrane.com/api/mcp bun ops/smoke.ts
```

Then by hand in a browser (same hosts entries): sign in with Google; open a project, play a
recording, open a report, start a chat; open a portal link and record ten seconds, check the chunk
transcribes; `~/server/tools/site-token.py` answers 422. Remove the hosts entries.

Verify: `passed` with 0 failed, and the manual list ticked. **Gate: Lead says go or rolls back
(R1).** This is the last point where a rollback loses nothing.

### W9. DNS switch (T+65, Lead, 5 min)

In Cloudflare: `api`, `dashboard`, `portal`, `directus` become A records to the load balancer IP,
DNS only, TTL 60 s. Directus: the hostname stays and serves old asset links from the new API
and sends everything else to the dashboard's sign-in; its REST API and admin app are gone, so
the iOS app stops working (accepted, see Consumers).

Verify: `dig +short api.dembrane.com @1.1.1.1` and `@8.8.8.8` return the load balancer IP; rerun
`ops/smoke.ts` without hosts entries; it passes. Downtime ends here.

**Point of no return: the first customer write on the new stack, which starts as soon as DNS
moves.** From here a rollback loses every write made on the new stack; the answer to a problem is
a fix forward, unless the Lead decides the loss is smaller than the problem.

### W10. Watch (T+70 to T+130, Second)

Cloud Monitoring dashboard for prod plus the alerts from P1: 5xx ratio, p95 latency, worker
pool, DBOS queue age, Cloud SQL CPU and connections. Error Reporting for new error groups. The
support inbox and Slack. Every 15 minutes, a line in the log. Specific checks:

- recordings: chunks arrive and get transcripts (`select count(*) from conversation_chunk where
  created_at > <W9> and transcript is null` stays small and drains);
- webhooks: `project_webhook` deliveries succeed in the worker log (customers need no change:
  same headers, same signature, same payloads);
- MCP: an existing grant's tool call succeeds (tokens are stored as hashes and the client secrets
  are keyed on the Directus secret, which W0 checked is `INVITE_HASH_SECRET`).

### W11. After the switch (T+75 onward, Operator)

- Full file pass: `STEP=files-final ops/files-sync.sh run` (about 50 minutes), then
  `bun ops/verify-files.ts --exclude conversation_id/` (full listing, 0 missing). Picks up anything uploaded through a
  presigned URL issued before the freeze. Then `ops/transfer-agents.sh down` for each VM.
- Stuck work from the freeze: conversations that were recording at T+0 and chunks without a
  transcript from the last two hours before it: `POST /api/conversations/<id>/retranscribe` as a
  staff user for each. Leftover Dramatiq messages from W1 (`/data/dramatiq-leftover.json`) are
  replayed by hand if they are webhook deliveries.
- sam: mint the staff key on the new database
  (`bun run accounts:staff-key mint <staff email> sam-pricing-digest` with the prod database URL),
  store it in sam's secrets, merge the prepared digest change.
- The 2FA note to the two customers (draft below), once the Lead approves it.
- Customer "back online" note, if a notice went out.

### W12. Close (T+130, Lead)

Declare the cutover done. The old stack stays frozen, not deleted: DO databases, Spaces and the
cluster at 0 replicas, for 30 days. Before DigitalOcean is shut down: archive
`directus_revisions` and `directus_activity` (19 GB) with
`SOURCE_DATABASE_URL=<old> ARCHIVE_DEST=gs://dembrane-web-prod-echo-archive/directus-audit packages/db/scripts/archive-tables.sh directus_revisions directus_activity`
and a final full `pg_dump` of the old database to the same bucket. Decide on `conversation_id/`
(8.65 TiB of old-library segment audio): copy it to the archive bucket in the Archive storage class
with a one-off transfer job (about 10 EUR a month) or let it go with Spaces. Nothing reads it.

## Rollback

### R1. Before the DNS switch (W1 to W8): no data loss

The new stack has taken no customer writes, so the old database is still the truth.

```sql
ALTER DATABASE defaultdb RESET default_transaction_read_only;
```

```sh
kubectl --context do-ams3-dbr-echo-prod-k8s-cluster -n argocd patch application echo-prod \
  --type merge -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}'
```

Argo restores every deployment and the four HPAs from git. Verify: all deployments at their
normal replica counts, `api.dembrane.com/api/v2/me` answers 401 (not 503), a test login on the
dashboard works, the scheduler logs a tick. Scale the new worker pool to 0 so nothing processes
the copy. Time to restore service: about 10 minutes.

### R2. After the DNS switch, before customer writes matter (Lead's call)

Revert the four Cloudflare records to the values noted in P4 (TTL 60 s), then R1. Writes made
on the new stack in between are lost unless exported first:
`bun ops/verify-db.ts` names the tables that changed; rows with `created_at` or `updated_at`
after W9 can be exported per table for replay by hand. Beyond the first hour this is almost
always worse than a fix forward.

## Consumers outside the two stacks

- **iOS app (dembrane-go):** logs in through Directus `/auth/login` and loads avatars from
  `/assets/<id>`. After W9 the login fails. Accepted by the CTO on 2026-09-28; iOS stays
  unmaintained until a login shim or an app update to Better Auth.
- **sam's pricing digest:** reads `pricing_configuration` straight from the DO database, which is
  read-only and then gone. New source: `GET /api/v2/admin/pricing-configurations?days=7` on the
  platform (staff key, scope `staff:accounts`, every read audited). P4 prepares the sam change,
  W11 switches it.
- **Website needs form:** `www.dembrane.com/pricing` posts through a Pages Function with
  `X-Site-Token` to `api.dembrane.com/api/v2/pricing-configurations/site`. The platform checks
  it against `ECHO_SUPPORT_WEBHOOK_TOKEN` (with `SITE_API_TOKEN` unset, as today), so the same
  value keeps Pages working with no redeploy. Checked in W8 by the smoke test (422 on an empty
  body) and `~/server/tools/site-token.py`.
- **Webhooks customers receive:** 10 on prod. Same table, same per-webhook secret, same
  `X-Webhook-Event` and `X-Webhook-Signature: sha256=<hmac>` over the same sorted JSON, same
  events; nothing changes for customers. Deliveries still queued in Dramatiq at the freeze are
  drained in W1; any left are saved and replayed by hand.
- **MCP and OAuth clients:** 7 clients, 4 live grants. Access and refresh tokens are stored as
  SHA-256 hashes in `agent_token` and survive the copy as they are. Confidential client secrets
  are encrypted with a key derived from Directus's `SECRET`; the platform derives it from
  `INVITE_HASH_SECRET`, which must be that same value (P1). The issuer and resource stay
  `https://api.dembrane.com/api/mcp`, and the consent page stays on the dashboard, so no client
  re-registers. Every signed-in user is signed out at W9 (Directus sessions do not carry over);
  passwords and Google accounts do, so they sign straight back in.
- **Two-factor users:** Directus's TOTP secrets are not copied into Better Auth. Three accounts
  have 2FA on prod: one at zaltbommel.nl, one at flyingelephants.nl, one at dembrane.com. After
  W9 they sign in with their password only until they set 2FA up again under Settings, Account and
  security, Two-factor. The note below tells the two customers.
- **Other Directus callers:** 22 users hold Directus static tokens. In the last 30 days only two
  used them, both internal: the old API's service account and the schema-release token. Both
  retire with the old stack. Pending Directus email-verification and password-reset links stop
  working; those people sign up again or reset on the dashboard.
- **Mollie:** payment webhooks go to the same path (`/api/v2/billing/mollie/webhook`) and Mollie
  retries for a day, so the downtime loses none.
- **Email images:** emails already sent embed `https://directus.dembrane.com/assets/<id>`; the
  load balancer rewrite keeps them. The platform's own templates still hardcode that host
  (`packages/account/src/emails.ts`, `packages/tenancy/src/emails.ts`,
  `packages/billing/src/emails.ts`); a follow-up moves them to the API host.

## Drafts (not sent)

Nothing below goes out without the Lead's explicit send.

### Customer maintenance notice

> Subject: dembrane maintenance on Saturday 3 October, 08:00 to 12:00 CEST
>
> On Saturday 3 October between 08:00 and 12:00 CEST we move dembrane to new infrastructure in
> the Netherlands. During that time the dashboard and the participant portal are unavailable, so
> please do not plan recording sessions in that window.
>
> What stays the same: your projects, conversations, recordings, reports and settings, your
> login and password, webhooks and connected AI assistants.
>
> What you will notice: you will be signed out once and sign in again as usual. If you use
> two-factor authentication, you will need to set it up again afterwards; we will write to you
> separately. The iOS app will not work for a while after the move; please use the dashboard
> in your browser.
>
> We will confirm here when everything is back. Questions: support@dembrane.com.

### Note to the two customers who use two-factor authentication

> Subject: please set up two-factor authentication again in dembrane
>
> On Saturday 3 October we moved dembrane to new infrastructure. Your account, projects and
> password came along, but two-factor authentication did not: for security it is not copied
> between systems.
>
> Until you set it up again, your account is protected by your password only. It takes a
> minute: sign in at https://dashboard.dembrane.com, open Settings, then Account and security,
> and turn on two-factor authentication with your authenticator app. You can remove the old
> dembrane entry from the app afterwards.
>
> If anything does not work, reply to this email.

## Rehearsal log (2026-09-28)

Source: echo-next, read-only (Postgres dump over the public DO host, Spaces with the dev keys).
Target: database `echo_rehearsal` on the preview Cloud SQL instance, first in `dembrane-echo`, then
again on `echo-preview` in `dembrane-web-previews` once the project split created it (same
timings: dump 17 s, restore 26 s, ANALYZE 4 s, migrate 11 s, verify 10 s). Files: a full copy of the
41.6 GiB into a scratch bucket (not a sample), through Storage Transfer with agents first on the
office box, then on a VM in europe-west4. The API ran as a temporary Cloud Run service in
`dembrane-echo` (for latency) and locally against the previews database. Every step above ran in
order; verify-db passed (102 tables equal, 89 sample checksums equal), verify-files passed (23,383
objects, 0 missing, 50 checksums equal), smoke passed 12 of 12. Not rehearsed: the freeze and R1,
which touch the old stack. What the rehearsal changed:

1. **Prod lacks 15 tables the baseline assumes.** `analysis_*`, `map_*` and `recording_overage`
   exist on echo-next, not on prod. The migrate job adopts the baseline without running it, so
   prod would have come out without them. Fixed with `0011_expand_prod_catchup` (idempotent,
   sorted before the contract, which became `0012_contract_dead_features`), proven by restoring
   prod's schema and comparing fingerprints with a fresh build: equal apart from six extra indexes
   and a `project_membership.role` column prod has.
2. **An expand migration after a contract breaks held databases.** Drizzle applies only
   migrations newer than the last applied; a database migrated with the contract held back would
   have skipped the contract forever. The catch-up therefore sorts before it; the migrate tests
   caught this.
3. **The archive cannot run in the window.** It is 20.6 GB, one table 11.8 GB. `archive-tables.sh`
   gained `SOURCE_DATABASE_URL` so it reads from the frozen old database; `ops/archive.sh` splits
   it into `pre` (days before) and `record` (in the window, recounts and records).
4. **The DO database is reachable directly.** It has no trusted sources: port 25060 on the public
   host answers from anywhere with the password. Worth closing after cutover; for the move it
   means pg_dump needs no hop through the cluster.
5. **Spaces is 9.9 TiB, and 8.65 TiB of it is dead.** A read-only listing of prod found the
   `conversation_id/` segment audio of the old library, untouched since October 2025 and
   referenced by nothing the platform keeps. `files-sync.sh` and `verify-files.ts` gained an
   exclusion, which brings the move to 1.24 TiB.
6. **The office line cannot move it.** Agents on this box moved 4.5 MB/s; agents on a VM in
   europe-west4 averaged 98 MB/s. Hence P2's VMs starting Wednesday, and a manifest-driven delta
   in the window instead of a full listing (about 50 minutes at prod's object count).
7. **STS needs read access to its manifest.** The first delta run failed with PERMISSION_DENIED
   until the service agent and the agents could read the manifest bucket (now in P1).
8. **Swapping agents mid-transfer leaves 412s.** Ten objects failed when the office agents
   stopped and the VM agents took over; a second pass copied them. `files-sync.sh run` fails
   loudly, and the fix is to run it again.
9. **Better Auth checks Origin.** A sign-in without the dashboard's origin gets 403; the smoke
   test sends it (`SMOKE_ORIGIN`).
10. **The avatar check failed until the files arrived.** Avatars are Directus files at the bucket
   root; the API serves them from the same keys once the copy lands. Nothing to change, but it is
   why W8 runs after W7.
11. **Cloud Run versus local latency.** The projects list took 25 s from a laptop over the proxy
    and 1.2 s on Cloud Run; judge latency only from the Cloud Run side.
12. **The default archive bucket does not exist.** `gs://dembrane-echo-archive` was never created;
    P1 asks for `dembrane-web-prod-echo-archive` and the runbook passes it explicitly.
