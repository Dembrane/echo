# The signals each part of the platform emits, and the alerts that fire when one is off.
# The same signals feed sam, so people and the agent read one source of truth.

variable "alert_channels" {
  type        = list(string)
  description = "Monitoring notification channel ids (Slack, email). Empty keeps alerts visible in the console only."
  default     = []
}

locals {
  run_filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.name}-api\""
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

resource "google_monitoring_alert_policy" "worker_down" {
  display_name = "${local.name}: worker heartbeat missing"
  combiner     = "OR"
  conditions {
    display_name = "no heartbeat for 5 minutes"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.worker_heartbeat.name}\" AND resource.type=\"cloud_run_worker_pool\""
      duration = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  documentation {
    content   = "Schedules and background jobs are not running. Check the worker pool's logs for a crash loop, then the database connection."
    mime_type = "text/markdown"
  }
  notification_channels = var.alert_channels
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
  notification_channels = var.alert_channels
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
  notification_channels = var.alert_channels
}

resource "google_monitoring_uptime_check_config" "api_ready" {
  display_name = "${local.name}: API ready"
  timeout      = "10s"
  period       = "300s"
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
  notification_channels = var.alert_channels
}
