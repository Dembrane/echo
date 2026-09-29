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
  alert_channels = concat(var.alert_channels, google_monitoring_notification_channel.email[*].id, google_monitoring_notification_channel.slack[*].id)
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
  count            = var.standing_deployment && var.monitor_worker_ready ? 1 : 0
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
      host       = "${local.name}-api-${data.google_project.this.number}.${var.region}.run.app"
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
  dynamic "conditions" {
    for_each = google_monitoring_uptime_check_config.worker_ready
    content {
      display_name = "executor heartbeat stale for 10 minutes (/ready/worker failing)"
      condition_threshold {
        filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${conditions.value.uptime_check_id}\""
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
  }
  # PR previews come and go, so an absent heartbeat is only an alarm where a worker always runs.
  dynamic "conditions" {
    for_each = var.standing_deployment ? [1] : []
    content {
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
  count        = var.standing_deployment && var.monitor_api_ready ? 1 : 0
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
      host       = "${local.name}-api-${data.google_project.this.number}.${var.region}.run.app"
    }
  }
}

resource "google_monitoring_alert_policy" "api_unready" {
  count        = var.standing_deployment && var.monitor_api_ready ? 1 : 0
  display_name = "${local.name}: API not ready"
  combiner     = "OR"
  conditions {
    display_name = "readiness check failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.api_ready[0].uptime_check_id}\""
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

# ── Service level: error ratio, latency, queue age, database CPU ───────────────────────
locals {
  api_series = "monitored_resource=\"cloud_run_revision\",service_name=\"${local.name}-api\""
}

resource "google_monitoring_alert_policy" "api_error_ratio" {
  display_name = "${local.name}: API 5xx ratio"
  combiner     = "OR"
  conditions {
    display_name = "more than 2% of API responses are 5xx over 5 minutes"
    condition_prometheus_query_language {
      query               = "sum(rate(run_googleapis_com:request_count{${local.api_series},response_code_class=\"5xx\"}[5m])) / sum(rate(run_googleapis_com:request_count{${local.api_series}}[5m])) > 0.02"
      duration            = "300s"
      evaluation_interval = "60s"
    }
  }
  documentation {
    content   = "Search the API logs for severity=ERROR; every line carries request_id. A deploy in the last hour is the first suspect."
    mime_type = "text/markdown"
  }
  notification_channels = local.alert_channels
}

# From the API's request lines rather than Cloud Run's request_latencies: those count a
# live stream (SSE) as one request lasting minutes, which would hold p95 above any threshold.
# The request line is written when the handler returns, so a stream counts its time to
# first byte.
resource "google_logging_metric" "api_latency" {
  name            = "${local.name}/api_latency"
  filter          = "${local.run_filter} AND jsonPayload.message=\"request\""
  value_extractor = "REGEXP_EXTRACT(jsonPayload.httpRequest.latency, \"([0-9.]+)s\")"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "s"
  }
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 30
      growth_factor      = 1.5
      scale              = 0.005
    }
  }
}

resource "google_monitoring_alert_policy" "api_latency" {
  display_name = "${local.name}: API p95 latency"
  combiner     = "OR"
  conditions {
    display_name = "API p95 latency above 2 s for 10 minutes"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.api_latency.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }
  documentation {
    content   = "Search the API's request lines for the slow routes (jsonPayload.route, httpRequest.latency) before scaling. Then Cloud SQL CPU and connections."
    mime_type = "text/markdown"
  }
  notification_channels = local.alert_channels
}

resource "google_logging_metric" "queue_oldest_ready" {
  name            = "${local.name}/queue_oldest_ready_s"
  filter          = "jsonPayload.signal=\"queue.depth\" AND jsonPayload.env=\"${var.env}\" AND jsonPayload.oldestReadyS>=0"
  value_extractor = "EXTRACT(jsonPayload.oldestReadyS)"
  label_extractors = {
    queue = "EXTRACT(jsonPayload.name)"
  }
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "s"
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

resource "google_monitoring_alert_policy" "queue_age" {
  display_name = "${local.name}: job waiting too long"
  combiner     = "OR"
  conditions {
    display_name = "a queue's oldest ready job has waited more than 10 minutes"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.queue_oldest_ready.name}\" AND resource.type=\"cloud_run_worker_pool\""
      comparison      = "COMPARISON_GT"
      threshold_value = 600
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["metric.label.queue"]
      }
    }
  }
  documentation {
    content   = "Jobs sit in the queue unclaimed: the worker is down, saturated, or the queue's concurrency is too low. Check the worker-down alert and the job backlog first."
    mime_type = "text/markdown"
  }
  notification_channels = local.alert_channels
}

resource "google_monitoring_alert_policy" "db_cpu" {
  display_name = "${local.name}: Cloud SQL CPU"
  combiner     = "OR"
  conditions {
    display_name = "Cloud SQL CPU above 80% for 10 minutes"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project}:${google_sql_database_instance.db.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "600s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  documentation {
    content   = "Query Insights on the instance names the expensive queries. A restore or index build during a cutover explains a spike."
    mime_type = "text/markdown"
  }
  notification_channels = local.alert_channels
}
