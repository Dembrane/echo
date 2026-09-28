# Settings that belong to the GCP project, not to one environment: preview, next and prod
# share dembrane-echo, so these live in one state of their own.
#   terraform init -backend-config="prefix=platform/project" && terraform apply
terraform {
  required_version = ">= 1.9"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
  backend "gcs" {
    bucket = "dbr-gcp-echo-tf-state"
  }
}

variable "project" {
  type    = string
  default = "dembrane-echo"
}

variable "log_location" {
  type        = string
  description = "Where application and request logs are stored. Same region as the services."
  default     = "europe-west4"
}

variable "log_retention_days" {
  type        = number
  description = "Days logs are kept. The first 30 cost nothing beyond ingestion."
  default     = 30
}

provider "google" {
  project = var.project
}

# Every log except the admin audit trail lands here instead of the global _Default bucket.
resource "google_logging_project_bucket_config" "eu" {
  project        = var.project
  location       = var.log_location
  bucket_id      = "eu-default"
  retention_days = var.log_retention_days
  description    = "Application, request and data access logs, stored in the EU."
}

# The project's _Default sink keeps its filter (everything the _Required sink does not take)
# and points at the EU bucket. The global _Default bucket keeps what it already holds until
# its 30 day retention runs out, then stays empty.
resource "google_logging_project_sink" "default" {
  name                   = "_Default"
  project                = var.project
  destination            = "logging.googleapis.com/${google_logging_project_bucket_config.eu.id}"
  filter                 = "NOT LOG_ID(\"cloudaudit.googleapis.com/activity\") AND NOT LOG_ID(\"externalaudit.googleapis.com/activity\") AND NOT LOG_ID(\"cloudaudit.googleapis.com/system_event\") AND NOT LOG_ID(\"externalaudit.googleapis.com/system_event\") AND NOT LOG_ID(\"cloudaudit.googleapis.com/access_transparency\") AND NOT LOG_ID(\"externalaudit.googleapis.com/access_transparency\")"
  unique_writer_identity = true
}

output "log_bucket" {
  value = google_logging_project_bucket_config.eu.id
}
