# @dembrane/config

Every setting echo reads is declared once in `src/schema.ts`. A value comes from, in rising
precedence: the schema default, the environment file in `environments/<APP_ENV>.ts`, the process
environment. Secrets come only from the process environment. `bun run config check` validates
every environment file and fails on a declared key nothing reads.

## Feature and kill switches

A switch nobody sets behaves the way prod behaves today, so a variable a deployment forgets
cannot turn a feature off at cutover. `test/kill-switches.test.ts` pins these values.

| Variable | Default | Prod today (Python stack, echo-gitops `values-prod.yaml`) |
| --- | --- | --- |
| `ENABLE_WEBHOOKS` | on | on, as `FEATURE_FLAGS__ENABLE_WEBHOOKS=1` (echo-next too) |
| `WEBHOOKS_ALLOW_PRIVATE_TARGETS` | off | no such check: Python posts to any address |
| `PARTICIPANT_TOKEN_REQUIRED` | off | no such check: the conversation id is the capability |
| `ENABLE_MONITOR` | on | unset, Python default on |
| `ENABLE_PRESENT` | on | unset, Python default on |
| `ENABLE_CANVAS` | on | unset, Python default on |
| `MOLLIE_FORCE_RECONCILE_FAILURE` | off | unset, Python default off |
| `BILLING_CUSTOMER_JOBS` | off | no such switch: Python runs customer jobs everywhere; `environments/prod.ts` sets on |
| `POPCORN_SHOW_FLOW` | off | follows `SERVE_API_DOCS`: 0 on prod, 1 on echo-next; `environments/next.ts` sets on |

Two rows differ from prod on purpose. `WEBHOOKS_ALLOW_PRIVATE_TARGETS` off blocks webhook targets
on loopback and private addresses, which Python never checked. `BILLING_CUSTOMER_JOBS` is on only
in prod, so an environment on a copy of prod data never mails or charges a real customer.
Preview keeps webhooks off in `environments/preview.ts`.
