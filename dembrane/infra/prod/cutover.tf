# What the cutover from the old prod (DigitalOcean, Directus) needs in this project, beside
# the platform itself: see CUTOVER.md, P1 and P2. Remove after the cutover is closed, except
# the archive bucket, which holds the contract and audit archives for a year.

# The contract archive, the Directus audit archive and the transfer manifests. Objects cannot
# be deleted for a year. The policy is not locked: locking is irreversible, so it is a
# separate, deliberate step (gcloud storage buckets update --lock-retention-period).
resource "google_storage_bucket" "archive" {
  name                        = "${local.project}-echo-archive"
  location                    = "europe-west4"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  retention_policy {
    retention_period = 31536000
  }
}

# ── Storage Transfer: Spaces (S3 API) to the uploads bucket, through agents on VMs ──────────
resource "google_project_service" "storagetransfer" {
  service            = "storagetransfer.googleapis.com"
  disable_on_destroy = false
}

# Storage Transfer refuses user credentials without a quota project, so its calls bill this
# project (the API is enabled here).
provider "google" {
  alias                 = "billed"
  project               = local.project
  region                = "europe-west4"
  user_project_override = true
  billing_project       = local.project
}

resource "google_storage_transfer_agent_pool" "cutover" {
  provider     = google.billed
  name         = "echo-cutover"
  display_name = "echo cutover: Spaces to GCS"
  depends_on   = [google_project_service.storagetransfer]
}

resource "google_service_account" "transfer" {
  account_id   = "echo-cutover-transfer"
  display_name = "echo cutover transfer agents"
}
resource "google_project_iam_member" "transfer_agent" {
  project = local.project
  role    = "roles/storagetransfer.transferAgent"
  member  = google_service_account.transfer.member
}
resource "google_storage_bucket_iam_member" "transfer_uploads" {
  bucket = module.platform.uploads_bucket
  role   = "roles/storage.objectAdmin"
  member = google_service_account.transfer.member
}
resource "google_storage_bucket_iam_member" "transfer_archive" {
  bucket = google_storage_bucket.archive.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.transfer.member
}

# The Storage Transfer service agent runs the jobs: it writes the sink and reads manifests.
data "google_storage_transfer_project_service_account" "agent" {
  provider   = google.billed
  project    = local.project
  depends_on = [google_project_service.storagetransfer]
}
resource "google_project_iam_member" "transfer_service_agent" {
  project = local.project
  role    = "roles/storagetransfer.serviceAgent"
  member  = data.google_storage_transfer_project_service_account.agent.member
}
resource "google_storage_bucket_iam_member" "service_agent_uploads" {
  bucket = module.platform.uploads_bucket
  role   = "roles/storage.admin"
  member = data.google_storage_transfer_project_service_account.agent.member
}
resource "google_storage_bucket_iam_member" "service_agent_archive" {
  for_each = toset(["roles/storage.objectViewer", "roles/storage.legacyBucketReader"])
  bucket   = google_storage_bucket.archive.name
  role     = each.value
  member   = data.google_storage_transfer_project_service_account.agent.member
}

# The prod Spaces keys as AWS_ACCESS_KEY_ID= and AWS_SECRET_ACCESS_KEY= lines. Created empty;
# the value is added by hand (gcloud secrets versions add echo-cutover-spaces --data-file=-).
resource "google_secret_manager_secret" "spaces" {
  secret_id = "echo-cutover-spaces"
  replication {
    user_managed {
      replicas { location = "europe-west4" }
    }
  }
}
resource "google_secret_manager_secret_iam_member" "spaces" {
  secret_id = google_secret_manager_secret.spaces.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.transfer.member
}

output "cutover" {
  value = {
    archive_bucket     = google_storage_bucket.archive.name
    agent_pool         = google_storage_transfer_agent_pool.cutover.name
    transfer_agents    = google_service_account.transfer.email
    transfer_service   = data.google_storage_transfer_project_service_account.agent.email
    spaces_keys_secret = google_secret_manager_secret.spaces.secret_id
  }
}
