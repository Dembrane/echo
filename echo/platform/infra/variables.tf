variable "project" {
  type        = string
  description = "GCP project that hosts the platform."
  default     = "dembrane-echo"
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
  default     = "db-g1-small"
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

variable "browser_origins" {
  type        = list(string)
  description = "Origins allowed to upload to and read from the bucket directly."
}
