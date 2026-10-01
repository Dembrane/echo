# PR previews' front door: dashboard-<n>, portal-<n> and api-<n>.preview.dembrane.com on one
# global external HTTPS load balancer with one wildcard certificate.
#
# Terraform owns the shared parts. scripts/deploy-env.sh owns each PR's serverless NEGs,
# backend services and host rules: it adds them when a PR preview is deployed and removes them
# at teardown, editing the URL map with a fingerprint-checked update so concurrent PR jobs
# cannot overwrite each other. Terraform therefore ignores the URL map's host rules and path
# matchers; an apply never drops a live preview's routes.
#
# DNS lives in Cloudflare, outside this project: output pr_preview_dns lists the two records.
# Until the _acme-challenge record exists the wildcard certificate stays in provisioning and
# the load balancer answers with the self-signed placeholder below.

locals {
  preview_domain = "preview.dembrane.com"
  pr_lb          = "echo-preview-pr-lb"
}

resource "google_project_service" "pr_lb" {
  for_each           = toset(["compute.googleapis.com", "certificatemanager.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_global_address" "pr" {
  name       = local.pr_lb
  depends_on = [google_project_service.pr_lb]
}

# Unknown hosts: the default route aborts with a plain 404 before any backend is contacted.
# A URL map needs a default backend, so it names a Cloud Run service that never exists.
resource "google_compute_region_network_endpoint_group" "pr_unknown" {
  name                  = "${local.pr_lb}-unknown"
  region                = "europe-west4"
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = "echo-preview-unknown-host" }
  depends_on = [google_project_service.pr_lb]
}

resource "google_compute_backend_service" "pr_unknown" {
  name                  = "${local.pr_lb}-unknown"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  backend { group = google_compute_region_network_endpoint_group.pr_unknown.id }
}

resource "google_compute_url_map" "pr" {
  name            = local.pr_lb
  default_service = google_compute_backend_service.pr_unknown.id
  default_route_action {
    fault_injection_policy {
      abort {
        http_status = 404
        percentage  = 100
      }
    }
  }
  lifecycle {
    ignore_changes = [host_rule, path_matcher]
  }
}

# One certificate for every PR host, authorised once by DNS and renewed by Google.
resource "google_certificate_manager_dns_authorization" "pr" {
  name       = replace(local.preview_domain, ".", "-")
  domain     = local.preview_domain
  location   = "global"
  depends_on = [google_project_service.pr_lb]
}

resource "google_certificate_manager_certificate" "pr" {
  name = "${local.pr_lb}-wildcard"
  managed {
    domains            = ["*.${local.preview_domain}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.pr.id]
  }
}

# Served when no entry matches the name or the wildcard certificate is not yet active, so the
# routes can be checked with curl --resolve -k before DNS exists. Browsers never trust it.
resource "tls_private_key" "pr_placeholder" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_self_signed_cert" "pr_placeholder" {
  private_key_pem       = tls_private_key.pr_placeholder.private_key_pem
  validity_period_hours = 24 * 365 * 5
  allowed_uses          = ["digital_signature", "server_auth"]
  dns_names             = ["*.${local.preview_domain}"]
  subject { common_name = "*.${local.preview_domain}" }
}

resource "google_certificate_manager_certificate" "pr_placeholder" {
  name = "${local.pr_lb}-placeholder"
  self_managed {
    pem_certificate = tls_self_signed_cert.pr_placeholder.cert_pem
    pem_private_key = tls_private_key.pr_placeholder.private_key_pem
  }
  depends_on = [google_project_service.pr_lb]
}

resource "google_certificate_manager_certificate_map" "pr" {
  name       = local.pr_lb
  depends_on = [google_project_service.pr_lb]
}

resource "google_certificate_manager_certificate_map_entry" "pr_wildcard" {
  name         = "${local.pr_lb}-wildcard"
  map          = google_certificate_manager_certificate_map.pr.name
  certificates = [google_certificate_manager_certificate.pr.id]
  hostname     = "*.${local.preview_domain}"
}

resource "google_certificate_manager_certificate_map_entry" "pr_primary" {
  name         = "${local.pr_lb}-primary"
  map          = google_certificate_manager_certificate_map.pr.name
  certificates = [google_certificate_manager_certificate.pr_placeholder.id]
  matcher      = "PRIMARY"
}

resource "google_compute_target_https_proxy" "pr" {
  name            = local.pr_lb
  url_map         = google_compute_url_map.pr.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.pr.id}"
}

# HTTPS only: previews are opened from links that already say https.
resource "google_compute_global_forwarding_rule" "pr_https" {
  name                  = "${local.pr_lb}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.pr.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.pr.id
}

# The deployer adds and removes each PR's NEGs, backend services and host rules. Only in this
# project, which holds nothing but previews.
resource "google_project_iam_member" "deployer_pr_routes" {
  project = local.project
  role    = "roles/compute.loadBalancerAdmin"
  member  = "serviceAccount:${module.platform.deployer}"
}

output "pr_preview_dns" {
  description = "The two Cloudflare records PR previews need, both DNS only (not proxied)."
  value = {
    wildcard = "*.${local.preview_domain} A ${google_compute_global_address.pr.address}"
    acme     = "${trimsuffix(google_certificate_manager_dns_authorization.pr.dns_resource_record[0].name, ".")} CNAME ${google_certificate_manager_dns_authorization.pr.dns_resource_record[0].data}"
  }
}
