# ── Media service (ffmpeg) ────────────────────────────────────────────────
# apps/media runs as an internal Cloud Run service (ADR 0002): ingress internal, IAM
# required, invoked only by the worker (pipeline) and the API (merge on first play,
# duration probes). It reads and writes audio through presigned URLs the caller signs,
# so its identity needs no bucket, database or secret access at all.
resource "google_service_account" "media" {
  account_id   = "${local.name}-media"
  display_name = "echo ${var.env} media service (ffmpeg)"
}
resource "google_project_iam_member" "media" {
  for_each = toset(["roles/cloudtrace.agent", "roles/monitoring.metricWriter"])
  project  = var.project
  role     = each.value
  member   = google_service_account.media.member
}
resource "google_service_account_iam_member" "deployer_acts_as_media" {
  service_account_id = google_service_account.media.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}

# Internal ingress only admits requests that arrive through a VPC, so the worker and
# the API send their traffic through this network (Direct VPC egress, all traffic).
# Private Google Access keeps Vertex, Cloud SQL's API and GCS on Google's network; the
# NAT gives everything else (webhook receivers, SendGrid, Mollie) a way out.
resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}
resource "google_compute_network" "run" {
  name                    = local.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.compute]
}
resource "google_compute_subnetwork" "run" {
  name                     = "${local.name}-run"
  network                  = google_compute_network.run.id
  region                   = var.region
  ip_cidr_range            = var.run_subnet_cidr
  private_ip_google_access = true
}
resource "google_compute_router" "run" {
  name    = "${local.name}-run"
  network = google_compute_network.run.id
  region  = var.region
}
resource "google_compute_router_nat" "run" {
  name                               = "${local.name}-run"
  router                             = google_compute_router.run.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

output "media_service_account" {
  value = google_service_account.media.email
}
output "run_network" {
  value = { network = google_compute_network.run.name, subnet = google_compute_subnetwork.run.name }
}
