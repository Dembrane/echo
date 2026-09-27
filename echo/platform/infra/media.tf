# ── Media service (ffmpeg) ────────────────────────────────────────────────
# apps/media runs as a private Cloud Run service (ADR 0002): public ingress with IAM
# required, so only identities granted run.invoker get through. The worker (pipeline) and
# the API (merge on first play, duration probes) hold that grant and call it with a
# Google ID token for its URL; no VPC, subnet or NAT is needed. It reads and writes audio
# through presigned URLs the caller signs, so its identity needs no bucket, database or
# secret access at all. The service itself and its invoker grants are made by the deploy
# job, like the other services.
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

output "media_service_account" {
  value = google_service_account.media.email
}
