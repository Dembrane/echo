variable "project" {
  type        = string
  description = "GCP project that hosts this environment and nothing else."
}

variable "region" {
  type        = string
  description = "Cloud Run and Cloud SQL region. Netherlands, same country as today's hosting."
  default     = "europe-west4"
}

variable "env" {
  type        = string
  description = "Environment name; matches an APP_ENV file in packages/config/environments."
  validation {
    condition     = contains(["preview", "next", "prod"], var.env)
    error_message = "env must be preview, next or prod."
  }
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier."
}

variable "db_max_connections" {
  type        = number
  description = "Set explicitly so the connection budget check reads the number the server enforces."
}

variable "db_environments" {
  type        = number
  description = "Deployments sharing the instance (preview: the branch preview plus the PR preview slots). Read by the connection budget check."
  default     = 1
}

variable "services" {
  description = <<-EOT
    Scaling per service, read by the deploy workflow and the connection budget check.
    cpu_always keeps CPU allocated outside requests (instance-based billing). The worker
    pool has no autoscaling: its min and max are both the instance count.
  EOT
  type = map(object({
    min         = number
    max         = number
    concurrency = optional(number, 1)
    cpu         = string
    memory      = string
    cpu_always  = optional(bool, false)
  }))
  validation {
    condition     = alltrue([for k in ["api", "dashboard", "portal", "media", "worker"] : contains(keys(var.services), k)])
    error_message = "services needs api, dashboard, portal, media and worker."
  }
  validation {
    condition     = alltrue([for s in values(var.services) : s.min <= s.max])
    error_message = "min instances must not exceed max instances."
  }
  validation {
    condition     = var.services["worker"].min == var.services["worker"].max
    error_message = "the worker pool runs a fixed number of instances: min must equal max."
  }
}

variable "github_repo" {
  type        = string
  description = "Only workflows in this repository may deploy."
  default     = "Dembrane/echo"
}

variable "deploy_ref" {
  type        = string
  description = "Git ref allowed to deploy this environment."
}

variable "deploy_tags" {
  type        = bool
  description = "Also accept tag refs (refs/tags/*)."
  default     = false
}

variable "deploy_ref_protected" {
  type        = bool
  description = "Accept deploy_ref only while GitHub reports it protected."
  default     = false
}

variable "deploy_environment" {
  type        = string
  description = "GitHub environment every deploying job must run in, so its protection rules (required reviewers) gate the deploy. Null accepts any job on the allowed refs."
  default     = null
}

variable "generate_invite_hash_secret" {
  type        = bool
  description = "Generate INVITE_HASH_SECRET. Off where it must equal Directus's SECRET (next, prod): the secret is created empty and its value added by hand."
  default     = true
}

variable "pending_secrets" {
  type        = list(string)
  description = <<-EOT
    Environment variables whose secrets are created empty and filled by hand
    (gcloud secrets versions add). The API and worker may read them; the deploy wires
    each one that has a version, found by its env-var label.
  EOT
  default     = []
}

variable "monitor_api_ready" {
  type        = bool
  description = "Probe the API's /ready. Off until the environment's first deploy, so an absent service does not show as down."
  default     = true
}

variable "pr_preview_environment" {
  type        = string
  description = "GitHub environment whose jobs may deploy PR previews from any ref. Null outside preview."
  default     = null
}

variable "browser_origins" {
  type        = list(string)
  description = "Origins allowed to upload to and read from the bucket directly."
}
