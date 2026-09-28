# The public front door: one global external HTTPS load balancer for the API, dashboard and
# portal, with Google-managed certificates authorised by DNS, so they are issued before any
# traffic moves. Optionally the old Directus hostname: /assets/* is served by the API's
# /api/assets/* (old email images and stored avatar links), everything else redirects to the
# dashboard's sign-in. Nothing here is used until DNS points the names at lb_ip.

variable "domains" {
  type = object({
    api       = string
    dashboard = string
    portal    = string
  })
  description = "Hostnames the load balancer serves. Null: no load balancer (the environment serves run.app URLs)."
  default     = null
}

variable "legacy_directus_host" {
  type        = string
  description = "The old Directus hostname, kept for old asset links. Null: not served."
  default     = null
}

variable "monitor_domains" {
  type        = bool
  description = "Uptime checks on the public hostnames. Off until DNS points them at this load balancer, or they probe the old stack."
  default     = false
}

locals {
  lb        = var.domains == null ? 0 : 1
  lb_roles  = var.domains == null ? {} : { api = var.domains.api, dashboard = var.domains.dashboard, portal = var.domains.portal }
  lb_hosts  = var.domains == null ? [] : compact(concat(values(local.lb_roles), [var.legacy_directus_host]))
  lb_prefix = "${local.name}-lb"
}

resource "google_compute_global_address" "lb" {
  count      = local.lb
  name       = local.lb_prefix
  depends_on = [google_project_service.apis]
}

resource "google_compute_region_network_endpoint_group" "run" {
  for_each              = local.lb_roles
  name                  = "${local.name}-${each.key}"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = "${local.name}-${each.key}" }
  depends_on = [google_project_service.apis]
}

resource "google_compute_backend_service" "run" {
  for_each              = local.lb_roles
  name                  = "${local.name}-${each.key}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  backend { group = google_compute_region_network_endpoint_group.run[each.key].id }
  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_url_map" "lb" {
  count           = local.lb
  name            = local.lb_prefix
  default_service = google_compute_backend_service.run["dashboard"].id

  dynamic "host_rule" {
    for_each = local.lb_roles
    content {
      hosts        = [host_rule.value]
      path_matcher = host_rule.key
    }
  }
  dynamic "path_matcher" {
    for_each = local.lb_roles
    content {
      name            = path_matcher.key
      default_service = google_compute_backend_service.run[path_matcher.key].id
    }
  }

  dynamic "host_rule" {
    for_each = var.legacy_directus_host == null ? [] : [var.legacy_directus_host]
    content {
      hosts        = [host_rule.value]
      path_matcher = "directus"
    }
  }
  dynamic "path_matcher" {
    for_each = var.legacy_directus_host == null ? [] : [var.legacy_directus_host]
    content {
      name = "directus"
      default_url_redirect {
        host_redirect          = var.domains.dashboard
        path_redirect          = "/login"
        https_redirect         = true
        strip_query            = true
        redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
      }
      route_rules {
        priority = 1
        match_rules { prefix_match = "/assets/" }
        service = google_compute_backend_service.run["api"].id
        route_action {
          url_rewrite {
            host_rewrite        = var.domains.api
            path_prefix_rewrite = "/api/assets/"
          }
        }
      }
    }
  }
}

# Certificates: one DNS authorization per hostname. Each needs its CNAME
# (output dns_authorizations) in DNS once; the certificate then issues and renews on its own.
resource "google_certificate_manager_dns_authorization" "lb" {
  for_each   = toset(local.lb_hosts)
  name       = replace(each.value, ".", "-")
  domain     = each.value
  location   = "global"
  depends_on = [google_project_service.apis]
}

resource "google_certificate_manager_certificate" "lb" {
  count = local.lb
  name  = local.lb_prefix
  managed {
    domains            = local.lb_hosts
    dns_authorizations = [for h in local.lb_hosts : google_certificate_manager_dns_authorization.lb[h].id]
  }
}

resource "google_certificate_manager_certificate_map" "lb" {
  count      = local.lb
  name       = local.lb_prefix
  depends_on = [google_project_service.apis]
}

resource "google_certificate_manager_certificate_map_entry" "lb" {
  for_each     = toset(local.lb_hosts)
  name         = replace(each.value, ".", "-")
  map          = google_certificate_manager_certificate_map.lb[0].name
  certificates = [google_certificate_manager_certificate.lb[0].id]
  hostname     = each.value
}

resource "google_compute_target_https_proxy" "lb" {
  count           = local.lb
  name            = local.lb_prefix
  url_map         = google_compute_url_map.lb[0].id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.lb[0].id}"
}

resource "google_compute_global_forwarding_rule" "https" {
  count                 = local.lb
  name                  = "${local.lb_prefix}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb[0].id
  port_range            = "443"
  target                = google_compute_target_https_proxy.lb[0].id
}

# Plain HTTP answers with a redirect to HTTPS.
resource "google_compute_url_map" "http" {
  count = local.lb
  name  = "${local.lb_prefix}-http"
  default_url_redirect {
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
  }
}
resource "google_compute_target_http_proxy" "http" {
  count   = local.lb
  name    = "${local.lb_prefix}-http"
  url_map = google_compute_url_map.http[0].id
}
resource "google_compute_global_forwarding_rule" "http" {
  count                 = local.lb
  name                  = "${local.lb_prefix}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb[0].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.http[0].id
}

# One check per public hostname, from outside, through DNS and the load balancer.
locals {
  domain_checks = var.monitor_domains ? merge(
    { for role, host in local.lb_roles : role => { host = host, path = role == "api" ? "/ready" : "/", class = "STATUS_CLASS_2XX" } },
    var.legacy_directus_host == null ? {} : { directus = { host = var.legacy_directus_host, path = "/assets/", class = "STATUS_CLASS_ANY" } },
  ) : {}
}

resource "google_monitoring_uptime_check_config" "domain" {
  for_each         = local.domain_checks
  display_name     = "${local.name}: ${each.value.host}"
  timeout          = "10s"
  period           = "60s"
  selected_regions = ["EUROPE", "USA"]
  http_check {
    path         = each.value.path
    port         = 443
    use_ssl      = true
    validate_ssl = true
    accepted_response_status_codes { status_class = each.value.class }
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project, host = each.value.host }
  }
}

resource "google_monitoring_alert_policy" "domain" {
  count        = length(local.domain_checks) > 0 ? 1 : 0
  display_name = "${local.name}: public hostname down"
  combiner     = "OR"
  conditions {
    display_name = "a public hostname fails its check for 5 minutes"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=monitoring.regex.full_match(\"${join("|", [for c in google_monitoring_uptime_check_config.domain : c.uptime_check_id])}\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }
  documentation {
    content   = "Check the load balancer's backend for the host, then the Cloud Run service behind it. A certificate that stopped renewing shows as an SSL failure."
    mime_type = "text/markdown"
  }
  notification_channels = local.alert_channels
}

output "lb_ip" {
  value = local.lb == 1 ? google_compute_global_address.lb[0].address : null
}
output "dns_authorizations" {
  description = "CNAME records that authorise the certificates."
  value       = { for h, a in google_certificate_manager_dns_authorization.lb : h => "${a.dns_resource_record[0].name} CNAME ${a.dns_resource_record[0].data}" }
}
