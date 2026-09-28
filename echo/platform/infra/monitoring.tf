# The signals each part of the platform emits, and the alerts that fire when one is off.
# The same signals feed sam, so people and the agent read one source of truth.

variable "alert_channels" {
  type        = list(string)
  description = "Monitoring notification channel ids (Slack, email). Empty keeps alerts visible in the console only."
  default     = []
}

variable "alert_email" {
  type        = string
  description = "Address every alert in this environment emails. Null sends nothing beyond alert_channels."
  default     = null
}

resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email == null ? 0 : 1
  display_name = "${local.name}: alerts by email"
  type         = "email"
  labels       = { email_address = var.alert_email }
}

locals {
  run_filter     = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.name}-api\""
  alert_channels = concat(var.alert_channels, google_monitoring_notification_channel.email[*].id)
  # The environment's worker pools. Preview's PR previews run their own pools
  # (echo-pr-<n>-worker) on the same identities; they count as preview's.
  worker_pools = var.env == "preview" ? "^echo-(preview|pr-[0-9]+)-worker$" : "^${local.name}-worker$"
}

resource "google_logging_metric" "worker_heartbeat" {
  name   = "${local.name}/worker_heartbeat"
  filter = "jsonPayload.signal=\"worker.heartbeat\" AND jsonPayload.env=\"${var.env}\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_logging_metric" "api_5xx" {
  name   = "${local.name}/api_5xx"
  filter = "${local.run_filter} AND jsonPayload.message=\"request\" AND jsonPayload.httpRequest.status>=500"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_logging_metric" "queue_ready" {
  name            = "${local.name}/queue_ready"
  filter          = "jsonPayload.signal=\"queue.depth\" AND jsonPayload.env=\"${var.env}\""
  value_extractor = "EXTRACT(jsonPayload.ready)"
  label_extractors = {
    queue = "EXTRACT(jsonPayload.name)"
  }
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    labels {
      key        = "queue"
      value_type = "STRING"
    }
  }
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 20
      growth_factor      = 2
      scale              = 1
    }
  }
}

# Cloud Run logs "Container called exit(<code>)." each time a worker process ends. Exit 0 is
# a rollout or scale-in; anything else is a crash, and a crash loop logs several a minute.
resource "google_logging_metric" "worker_exits" {
  name   = "${local.name}/worker_exits"
  filter = "resource.type=\"cloud_run_worker_pool\" AND resource.labels.worker_pool_name=~\"${local.worker_pools}\" AND textPayload:\"Container called exit(\" AND NOT textPayload:\"exit(0)\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# Answers 200 only while the newest executor heartbeat (written every 10 s once the queue
# runs) is under 90 s old; see apps/api/src/routes/system.ts.
resource "google_monitoring_uptime_check_config" "worker_ready" {
  display_name     = "${local.name}: worker heartbeat fresh"
  timeout          = "10s"
  period           = "300s"
  selected_regions = ["EUROPE", "USA"]
  http_check {
    path         = "/ready/worker"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project
      host       = "${local.name}-api-86405194907.${var.region}.run.app"
    }
  }
}

# Three views of one failure: the worker process keeps exiting, its executor heartbeat row
# goes stale, or the per-minute heartbeat job stops logging. Series are summed per pool,
# so a rollout (a new revision taking over) does not read as a missing heartbeat.
resource "google_monitoring_alert_policy" "worker_down" {
  display_name = "${local.name}: worker down"
  combiner     = "OR"
  conditions {
    display_name = "worker container exits more than 3 times in 10 minutes"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.worker_exits.name}\" AND resource.type=\"cloud_run_worker_pool\""
      comparison      = "COMPARISON_GT"
      threshold_value = 3
      duration        = "0s"
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.worker_pool_name"]
      }
    }
  }
  conditions {
    display_name = "executor heartbeat stale for 10 minutes (/ready/worker failing)"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.worker_ready.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }
  conditions {
    display_name = "no heartbeat job for 5 minutes"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.worker_heartbeat.name}\" AND resource.type=\"cloud_run_worker_pool\" AND resource.label.worker_pool_name=\"${local.name}-worker\""
      duration = "300s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.worker_pool_name"]
      }
    }
  }
  documentation {
    content   = "Schedules and background jobs are not running. Search the worker pool's logs for jsonPayload.signal=\"worker.boot_failed\": that line names the cause (socket, host, auth, database, capacity). /ready/worker on the API gives the heartbeat age."
    mime_type = "text/markdown"
  }
  notification_channels = local.alert_channels
}

resource "google_monitoring_alert_policy" "api_errors" {
  display_name = "${local.name}: API server errors"
  combiner     = "OR"
  conditions {
    display_name = "more than 10 server errors in 5 minutes"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.api_5xx.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  documentation {
    content   = "Search the API logs for severity=ERROR; every line carries request_id and a trace link."
    mime_type = "text/markdown"
  }
  notification_channels = local.alert_channels
}

resource "google_monitoring_alert_policy" "queue_backlog" {
  display_name = "${local.name}: job backlog"
  combiner     = "OR"
  conditions {
    display_name = "a queue holds more than 100 ready jobs for 10 minutes"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.queue_ready.name}\" AND resource.type=\"cloud_run_worker_pool\""
      comparison      = "COMPARISON_GT"
      threshold_value = 100
      duration        = "600s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["metric.label.queue"]
      }
    }
  }
  documentation {
    content   = "Jobs arrive faster than the worker finishes them. Check for a failing handler (job failed lines) before adding worker instances."
    mime_type = "text/markdown"
  }
  notification_channels = local.alert_channels
}

resource "google_monitoring_uptime_check_config" "api_ready" {
  display_name = "${local.name}: API ready"
  timeout      = "10s"
  period       = "300s"
  # Checkers cannot be limited to Europe (the API needs at least three locations and Europe
  # is one); USA adds three and keeps South America and Asia out. A probe carries no data.
  selected_regions = ["EUROPE", "USA"]
  http_check {
    path         = "/ready"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project
      host       = "${local.name}-api-86405194907.${var.region}.run.app"
    }
  }
}

resource "google_monitoring_alert_policy" "api_unready" {
  display_name = "${local.name}: API not ready"
  combiner     = "OR"
  conditions {
    display_name = "readiness check failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.api_ready.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }
  documentation {
    content   = "The API answers but cannot reach its database, or does not answer. /ready names what is failing."
    mime_type = "text/markdown"
  }
  notification_channels = local.alert_channels
}
