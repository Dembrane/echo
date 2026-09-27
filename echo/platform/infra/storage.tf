# Audio and uploads. Reached through the S3 API (GCS interoperability) so the storage
# package runs unchanged against GCS, DigitalOcean Spaces, MinIO or any S3 provider.
resource "google_storage_bucket" "uploads" {
  name                        = "${var.project}-${local.name}-uploads"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = var.env == "prod" }
  soft_delete_policy { retention_duration_seconds = 604800 }
  cors {
    origin          = var.browser_origins
    method          = ["GET", "PUT", "HEAD"]
    response_header = ["Content-Type", "Content-Length", "ETag"]
    max_age_seconds = 3600
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "storage" {
  account_id   = "${local.name}-storage"
  display_name = "echo ${var.env} object storage (S3 interoperability)"
}
resource "google_storage_bucket_iam_member" "storage" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectUser"
  member = google_service_account.storage.member
}
resource "google_storage_hmac_key" "storage" {
  service_account_email = google_service_account.storage.email
}

locals {
  storage_secrets = {
    S3_ACCESS_KEY_ID     = google_storage_hmac_key.storage.access_id
    S3_SECRET_ACCESS_KEY = google_storage_hmac_key.storage.secret
  }
}
resource "google_secret_manager_secret" "storage" {
  for_each  = local.storage_secrets
  secret_id = "${local.name}-${lower(replace(each.key, "_", "-"))}"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
}
resource "google_secret_manager_secret_version" "storage" {
  for_each    = local.storage_secrets
  secret      = google_secret_manager_secret.storage[each.key].id
  secret_data = each.value
}
resource "google_secret_manager_secret_iam_member" "storage_readers" {
  for_each = {
    for pair in setproduct(keys(local.storage_secrets), ["api", "worker"]) : "${pair[0]}-${pair[1]}" => pair
  }
  secret_id = google_secret_manager_secret.storage[each.value[0]].id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value[1] == "api" ? google_service_account.api.member : google_service_account.worker.member
}
