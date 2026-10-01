# Every log except the admin audit trail lands in an EU bucket instead of the global
# _Default bucket. Each environment's root imports the project's existing _Default sink.

variable "log_retention_days" {
  type        = number
  description = "Days logs are kept. The first 30 cost nothing beyond ingestion."
  default     = 30
}

resource "google_logging_project_bucket_config" "eu" {
  project        = var.project
  location       = var.region
  bucket_id      = "eu-default"
  retention_days = var.log_retention_days
  description    = "Application, request and data access logs, stored in the EU."
  depends_on     = [google_project_service.apis]
}

# The _Default sink keeps its filter (everything the _Required sink does not take) and
# points at the EU bucket.
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
