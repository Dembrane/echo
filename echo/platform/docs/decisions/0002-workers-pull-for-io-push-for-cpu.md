# 0002 Workers: pull for I/O, push for CPU

**Decision.** Three runtimes on Cloud Run.
- `api`: service, autoscaled on requests. Never runs background work.
- `worker`: worker pool, always on, small. Runs DBOS jobs and workflows that mostly wait on the
  network (transcription, language models, webhooks, email, agent runs, analysis ticks)
  with high concurrency, and runs the schedules; DBOS runs each cron tick once across instances.
- `media`: private service, concurrency 1, 2 vCPU, 4 GiB, scales 0 to N. The worker hands
  it ffmpeg work over IAM-authenticated HTTP, so Cloud Run autoscales it on request count.
  Ingress is open but IAM is required: only the worker and API identities hold run.invoker
  and present a Google ID token, so no VPC or NAT sits in front of it.

**Why.** The two workload shapes need opposite sizing: hundreds of concurrent waits on a
small instance versus one CPU-bound job on a large one. Today's single scheduler replica
has no failover; DBOS schedules do.

**Best practice followed.** Web services never spawn background jobs (swe_guidelines
"Worker Roles"). Workers are always on with CPU allocated.

**Deviation.** The guidelines keep all work in pull-based workers. Media is push-based so
it scales to zero and autoscales without a custom metrics autoscaler.

**Against.** An extra hop, and a Cloud Run request holds at most 60 minutes. Chunk work
takes seconds to minutes; a timed-out hand-off is a failed step and is retried. Worker pool autoscaling is
manual or metric-driven, so the worker starts at a fixed small count and alerts on queue
depth.
