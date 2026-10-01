# Alerts to Slack. Monitoring publishes every incident of this project to a Pub/Sub topic;
# a push subscription hands it to the relay (infra/alert-relay), a Cloud Run service of its
# own that shares nothing with the platform API, so an API or database outage still alerts.
# The relay posts one message per incident and replies in its thread when it closes.
#
# First apply in a project: `terraform apply -target=module.platform.google_secret_manager_secret.slack_token`,
# then `infra/alert-relay.sh <env>` (pushes the image and fills the token), then a full apply.

variable "slack_channel" {
  type        = string
  description = "Slack channel id every alert posts to (#alerts-ci). Null keeps alerts to email."
  default     = null
}

locals {
  slack      = var.slack_channel == null ? 0 : 1
  relay_dir  = "${path.module}/../../alert-relay"
  relay_tag  = substr(sha256(join("", [for f in sort(tolist(fileset(local.relay_dir, "*"))) : filesha256("${local.relay_dir}/${f}")])), 0, 12)
  relay_name = "${local.name}-alert-relay"
}

resource "google_pubsub_topic" "alerts" {
  count                      = local.slack
  name                       = "${local.name}-alerts"
  message_retention_duration = "86400s"
  depends_on                 = [google_project_service.apis]
}

resource "google_monitoring_notification_channel" "slack" {
  count        = local.slack
  display_name = "${local.name}: Slack #alerts-ci (through the relay)"
  type         = "pubsub"
  labels       = { topic = google_pubsub_topic.alerts[0].id }
}

# Monitoring publishes as its notification service agent.
resource "google_pubsub_topic_iam_member" "monitoring_publishes" {
  count  = local.slack
  topic  = google_pubsub_topic.alerts[0].id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-monitoring-notification.iam.gserviceaccount.com"
  # The service agent exists once the project has a notification channel.
  depends_on = [google_monitoring_notification_channel.slack]
}

resource "google_secret_manager_secret" "slack_token" {
  count     = local.slack
  secret_id = "${local.relay_name}-slack-token"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

# Where the relay keeps each open incident's Slack thread.
resource "google_storage_bucket" "relay_state" {
  count                       = local.slack
  name                        = "${var.project}-${local.relay_name}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  lifecycle_rule {
    condition { age = 90 }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "relay" {
  count        = local.slack
  account_id   = local.relay_name
  display_name = "echo ${var.env} alert relay to Slack"
  depends_on   = [google_project_service.apis]
}
resource "google_storage_bucket_iam_member" "relay_state" {
  count  = local.slack
  bucket = google_storage_bucket.relay_state[0].name
  role   = "roles/storage.objectUser"
  member = google_service_account.relay[0].member
}
resource "google_secret_manager_secret_iam_member" "relay_token" {
  count     = local.slack
  secret_id = google_secret_manager_secret.slack_token[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.relay[0].member
}

resource "google_cloud_run_v2_service" "relay" {
  count               = local.slack
  name                = local.relay_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  template {
    service_account = google_service_account.relay[0].email
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    containers {
      image = "${var.region}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.images.repository_id}/alert-relay:${local.relay_tag}"
      resources {
        limits   = { cpu = "1", memory = "256Mi" }
        cpu_idle = true
      }
      env {
        name  = "ENV_NAME"
        value = var.env
      }
      env {
        name  = "SLACK_CHANNEL"
        value = var.slack_channel
      }
      env {
        name  = "STATE_BUCKET"
        value = google_storage_bucket.relay_state[0].name
      }
      env {
        name = "SLACK_BOT_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.slack_token[0].secret_id
            version = "latest"
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.relay_token]
}

# Pub/Sub pushes as this identity; only it may invoke the relay.
resource "google_service_account" "relay_push" {
  count        = local.slack
  account_id   = "${local.name}-alert-push"
  display_name = "echo ${var.env} Pub/Sub push to the alert relay"
  depends_on   = [google_project_service.apis]
}
resource "google_cloud_run_v2_service_iam_member" "relay_push" {
  count    = local.slack
  name     = google_cloud_run_v2_service.relay[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.relay_push[0].member
}

resource "google_pubsub_subscription" "relay" {
  count                      = local.slack
  name                       = local.relay_name
  topic                      = google_pubsub_topic.alerts[0].id
  ack_deadline_seconds       = 30
  message_retention_duration = "86400s"
  expiration_policy { ttl = "" }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
  push_config {
    push_endpoint = google_cloud_run_v2_service.relay[0].uri
    oidc_token { service_account_email = google_service_account.relay_push[0].email }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.relay_push]
}
