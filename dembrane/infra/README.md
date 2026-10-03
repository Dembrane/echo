# Infrastructure

Each environment is its own GCP project, directly under the dembrane.com organization, with
its own Terraform root, state and identities. No identity of one environment holds a role
in another's project, so a preview (which any PR branch can deploy) cannot reach staging or prod.

Production services do not run here: they run on DigitalOcean Kubernetes through
Dembrane/echo-gitops (`helm/dembrane-web`), and the `platform` workflow's prod job only pushes
images to `registry.digitalocean.com/dbr-cr` and bumps the image tag there. `prod/` still
holds the `dembrane-web-prod` project (the Vertex AI project prod's models are billed to).
Every push to main takes the same path to echo-next (the `dembrane-web-dummy` app on the
DigitalOcean dev cluster), through its own values file, with no tag and no approval.

| Environment | Project | Number | Root | State |
|---|---|---|---|---|
| preview | `dembrane-web-previews` | 218237812097 | `preview/` | `gs://dembrane-web-previews-tf-state` |
| staging | `dembrane-web-staging` | 1089877593337 | `staging/` | `gs://dembrane-web-staging-tf-state` |
| prod | `dembrane-web-prod` | 740075346439 | `prod/` | `gs://dembrane-web-prod-tf-state` |

The roots are thin: each calls `modules/platform` with its `<env>.tfvars.json`. Once per
project, `bootstrap.sh <env>` makes the state bucket (versioned, europe-west4) and turns off
Trace, Telemetry and the default APIs the platform never calls. Then:

```
cd <env>
terraform init
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) terraform apply
```

Per project: the APIs the platform uses (Cloud Run, Cloud SQL, Artifact Registry, Secret
Manager, IAM, STS, Storage, Vertex AI, Logging, Monitoring), a registry `echo-<env>`, a Cloud
SQL instance `echo-<env>`, the uploads bucket with its HMAC key, secrets replicated in
europe-west4 only, the runtime and deployer service accounts, the GitHub trust, the EU log
bucket with the `_Default` sink pointed at it, log metrics, alerts and the readiness check.
staging and prod also have the load balancer (`api`, `dashboard` and `portal`; prod adds the old
`directus` host). prod has, in `prod/cutover.tf`, what the cutover needs: the archive bucket
and Storage Transfer.

Alerts go to email (`alert_email`) and to Slack #alerts-ci. Monitoring publishes each
incident to a Pub/Sub topic; a push subscription hands it to `alert-relay/`, a Cloud Run
service apart from the platform API, which posts one message per incident and replies in its
thread when the incident closes. A new project needs the relay's token and image before its
first full apply:

```
terraform apply -target=module.platform.google_secret_manager_secret.slack_token
../alert-relay.sh <env>    # pushes the image, puts sam's Slack bot token in the secret
terraform apply
```

A change to `alert-relay/` changes the image tag Terraform expects: run `alert-relay.sh` for
each environment before the next apply. Deploy failures in CI post to the same channel with
the repository secret `SLACK_ALERTS_BOT_TOKEN`.

Images: each environment has its own registry and only its own deployer pushes to it. A
shared registry would let the preview deployer, which runs for any PR branch, overwrite a
tag that prod then pulls.

GitHub trust (the workload identity provider's condition), all in `Dembrane/echo`:
- preview: `refs/heads/feat/bun-migration`, or jobs in the `pr-preview` environment;
- staging: `refs/heads/main`;
- prod: protected `refs/heads/main` or a tag, and only jobs in the `prod` environment,
  whose required reviewers approve each deploy.

Services and jobs are rolled out by `.github/workflows/platform.yml` through
`.github/scripts/deploy-env.sh`, with the image built from the commit; Terraform owns everything
around them: registry, database, logins, secrets, identities and the keyless GitHub trust.
`<env>.tfvars.json` also holds each service's scaling, which the deploy reads, so one file
sizes an environment.

## Environments

| | preview | staging | prod |
|---|---|---|---|
| Deploys | PR previews from the `preview` label | main, by hand (every push once `STAGING_DEPLOY_ON_MAIN` is true) | a release tag on main, after approval |
| API | 0 to 1, concurrency 1000 | 2 to 2 | 2 to 10 |
| Dashboard, portal | 0 to 1 each | 2 to 2 each | 2 to 4 each |
| Media (ffmpeg, one job per instance) | 0 to 1 | 0 to 4 | 1 to 20 |
| Worker pool | 1 | 2 | 4 |
| Cloud SQL | db-custom-1-3840, 100 connections, shared by all previews | db-custom-1-3840, 100 | db-custom-2-8192, 400, regional HA |
| Database | `echo_pr_<n>` per PR | `echo` | `echo` |

PR previews come only from pull request events. Adding the `preview` label to a PR creates
`echo-pr-<n>-*` and database `echo_pr_<n>` on the preview instance, and each push to a
labelled PR redeploys it. There is no manual path: the workflow's manual run deploys staging or
prod only. At most three exist; a fourth tears down the oldest. Removing the label, closing
or merging the PR tears its own down. Previews share the preview identities, secrets and
bucket. Jobs deploying PR previews run in the GitHub environment `pr-preview`, the only
non-branch identity the preview deploy trust accepts; add required reviewers there to limit
who can deploy a PR.

Every PR preview deploy seeds its database after the migrations, in the migrate job
(`apps/migrate/src/preview-seed.ts`): the staff Administrator `sameer+admin@dembrane.com`,
whose password is the `preview-admin-password` secret (Terraform creates it empty; the value
is added with `gcloud secrets versions add`), the Millbrook sample workspace
(`packages/samples`: 25 synthetic conversations, a report and a chat) and the accounts demo,
whose two logins get the same password. Email is on: `echo-preview-sendgrid-api-key` holds
echo-next's SendGrid key.

PR preview hostnames, where n is the PR number:
- `dashboard-<n>.preview.dembrane.com` and `portal-<n>.preview.dembrane.com`, which forward
  `/api` to the API server to server, so the browser stays same-origin;
- `api-<n>.preview.dembrane.com`, the API's public URL: the MCP OAuth issuer and its
  `/.well-known` documents live at the API origin's root, which the web servers do not forward.

`preview/lb.tf` holds the shared front door: one global external HTTPS load balancer, one
Certificate Manager certificate for `*.preview.dembrane.com` authorised by DNS, and a URL
map whose default route answers unknown hosts with a plain 404. `deploy-env.sh` owns each
PR's part: a serverless NEG and backend service per role, named like its Cloud Run service,
and one host rule per hostname. The deploy adds them and teardown removes them, routes
first. NEGs and backend services belong to one PR, so concurrent jobs never share them; the
URL map is shared, so each edit reads it, changes only `pr-<n>-*` rules and writes it back
with the fingerprint it read, retrying when Google rejects a stale one. Terraform ignores
the URL map's host rules, so an apply never drops a live preview's routes. A per-PR
Terraform workspace could not do this: the URL map is one resource, and each workspace would
overwrite the others' rules.

A PR preview's dashboard and portal have ingress `internal-and-cloud-load-balancing`, so they
answer only through the load balancer. Its API keeps public ingress, because the web servers
reach it from outside any VPC. Sign-in cookies stay host-only (`AUTH_COOKIE_DOMAIN` unset):
all PR previews share `AUTH_SECRET`, and a cookie scoped to `preview.dembrane.com` would
cross from one preview's database to another's.

DNS is in Cloudflare. `terraform output pr_preview_dns` gives the two records, both DNS only
(not proxied): the wildcard `A` record to the load balancer, and the `_acme-challenge` CNAME
that lets the certificate issue. Until that CNAME exists the certificate stays in
provisioning and the load balancer serves a self-signed placeholder, so the routes can be
checked with `curl --resolve dashboard-<n>.preview.dembrane.com:443:<ip> -k`.

CPU is always allocated on the API: it holds a LISTEN connection that feeds live streams,
DBOS's client pool and fire-and-forget work (analytics, pool keepalives) outside any request.
The web servers and media do all their work inside requests, so they are billed per request.

## Database connections

Every process connects directly to Postgres. Cloud SQL's managed pooling needs Enterprise
Plus, and a transaction-mode pooler (managed or PgBouncer) would break DBOS and the stream
hub, which LISTEN, and presence, which holds session advisory locks; session mode saves
nothing. So pools are sized to the server instead, and `packages/config/test/capacity.test.ts`
fails CI when an environment would not fit:

```
environments × (API max × per-API + workers × per-worker + migrate 3) + reserved 3 + headroom ≤ max_connections
per-API    = DATABASE_POOL_MAX + 4   (DBOS client 2, LISTEN 1, presence 1)
per-worker = DATABASE_POOL_MAX + DATABASE_QUEUE_POOL_MAX + 4   (DBOS client 2, heartbeat 2)
headroom   = 10% of max_connections, at least 5
```

| | pools (app, queue) | per API | per worker | needed | max_connections |
|---|---|---|---|---|---|
| preview (4 deployments) | 3, 2 | 7 | 9 | 4 × (7 + 9 + 3) + 3 + 10 = 89 | 100 |
| staging | 5, 3 | 9 | 12 | 2×9 + 2×12 + 3 + 3 + 10 = 58 | 100 |
| prod | 10, 10 | 14 | 24 | 10×14 + 4×24 + 3 + 3 + 40 = 282 | 400 |

## Monthly cost, europe-west4 list prices

- preview: about $60 for Cloud SQL, $50 per always-on worker pool (branch plus up to three
  PRs), a few dollars for services that scale to zero: $110 with the branch alone, $260 with
  three PR previews up.
- staging: $100 API (2 always-on), $40 dashboard and portal (4 warm, idle priced), $100 worker
  pool (2), $60 Cloud SQL: about $300.
- prod: $160 API (2 to 3 instances on average), $60 dashboard and portal, $210 worker pool
  (4), $55 media, $245 Cloud SQL (2 vCPU, 8 GB, HA): about $730, before storage, egress and
  Vertex usage.

## EU residency

| Service | Where data lives | How it is enforced | What cannot move |
|---|---|---|---|
| Cloud Run services, worker pools, jobs | europe-west4 | region in `deploy-env.sh` and tfvars | |
| Cloud SQL | europe-west4, backups in the EU multi-region | `var.region` | |
| Cloud Storage (uploads, Terraform state) | europe-west4 | `var.region` | |
| Artifact Registry | europe-west4 | `var.region` | |
| Secret Manager | europe-west4 replicas only | user-managed replication on every secret | |
| Vertex AI generation | EU multi-region endpoint (`aiplatform.eu.rep.googleapis.com`) | `LLM_VERTEX_LOCATION=eu`, config residency test | |
| Vertex embeddings | europe-west4 | `EMBEDDING_LOCATION`, config residency test | |
| SendGrid | EU data residency | `SENDGRID_REGION=eu`, config residency test | |
| Cloud Logging | bucket `eu-default` in europe-west4, 30 days | `_Default` sink in `modules/platform/logging.tf` | `_Required` (admin activity and system event audit logs, 400 days) stays global: Google does not allow moving it |
| Cloud Trace | nothing stored | Trace and Telemetry APIs disabled by `bootstrap.sh`; no spans recorded or exported (config residency test) | |
| Cloud Monitoring | metrics and alert history are stored globally | | no location setting; the platform's metrics carry queue names and counts, no customer data |
| Uptime checks | probes from Europe and the US | `selected_regions` | at least three locations are required and Europe is one, so US checkers stay; a probe reads `/ready` only |
| Cloud Build | not used by the platform (images build in GitHub Actions) | | |

The three projects hold nothing but the platform. The default log storage location for new
projects is an organization setting
(`gcloud logging settings update --organization=535152468605 --storage-location=europe-west4`)
and needs an organization admin; an organization policy on `gcp.resourceLocations`
(`in:eu-locations`) would enforce all of the above for new resources.

## First deploy of staging and prod

Terraform has made everything around the services; the services themselves come from the
first `platform` workflow run with target staging. Before it:

- Add a value to each empty secret with `gcloud secrets versions add echo-<env>-<name>
  --data-file=-`. `invite-hash-secret` must hold Directus's SECRET while Directus-era invite
  links are in inboxes. The others (`sendgrid-api-key`, `auth-google-client-secret`,
  `mollie-api-key`, `echo-support-webhook-token`, `site-api-token`,
  `accounts-slack-webhook-url`, `accounts-events-secret`, `agent-client-secret-key`) switch
  their feature on; the deploy wires each one that has a value and leaves the rest off.
- Create the `staging` GitHub environment with a deployment rule for main, and the `prod`
  one with required reviewers and a deployment rule for main and tags. A job naming an environment that does not exist creates it unprotected.
- prod: add the four `_acme-challenge` CNAMEs from `terraform output platform`
  (`dns_authorizations`) in Cloudflare, so the certificates are ACTIVE before the switch.
  staging: add its one `_acme-challenge` CNAME and the `*.staging` A record (`lb_ip`) the
  same way; its certificate is a wildcard, authorised once.
- Run the workflow with target staging. `hold_data` (on by default) deploys the migrate
  job without running it and keeps the worker pool at 0, for a database that a restore fills
  first; run with it off once the data is in.
- After the first deploy set `monitor_api_ready` and `monitor_worker_ready` to true in the
  root; on prod set `monitor_domains` once DNS points at the load balancer.
