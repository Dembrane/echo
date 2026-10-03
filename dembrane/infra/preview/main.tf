# The preview environment, alone in GCP project dembrane-web-previews. Its state lives in a bucket
# in the same project (made by ../bootstrap.sh), and nothing here holds a role anywhere else.
terraform {
  required_version = ">= 1.9"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
    tls    = { source = "hashicorp/tls", version = "~> 4.0" }
  }
  backend "gcs" {
    bucket = "dembrane-web-previews-tf-state"
  }
}

locals {
  project  = "dembrane-web-previews"
  settings = jsondecode(file("${path.module}/../preview.tfvars.json"))
}

provider "google" {
  project = local.project
  region  = "europe-west4"
}

module "platform" {
  source                 = "../modules/platform"
  operators              = ["sam-runtime@dembrane-sameer-cli.iam.gserviceaccount.com"]
  project                = local.project
  env                    = local.settings.env
  deploy_ref             = local.settings.deploy_ref
  browser_origins        = local.settings.browser_origins
  db_tier                = local.settings.db_tier
  db_max_connections     = local.settings.db_max_connections
  db_environments        = lookup(local.settings, "db_environments", 1)
  services               = local.settings.services
  alert_email            = lookup(local.settings, "alert_email", null)
  slack_channel          = "C0C4HBZNSNT" # #alerts-ci
  pr_preview_environment = local.settings.pr_preview_environment
  # Only PR previews run here; each creates its own database.
  standing_deployment = false
  # Sign-up and sign-in codes work on every PR preview. The key is echo-next's, added by hand.
  pending_secrets = ["SENDGRID_API_KEY"]
}

# The PR preview seed (apps/migrate/src/preview-seed.ts) signs in sameer+admin@dembrane.com
# and the accounts demo's two logins with this password. Created empty; the value is added
# with `gcloud secrets versions add preview-admin-password --data-file=-`.
resource "google_secret_manager_secret" "preview_admin_password" {
  secret_id = "preview-admin-password"
  replication {
    user_managed {
      replicas { location = "europe-west4" }
    }
  }
}

# The seed runs in each PR preview's migrate job: it reads the password, and the accounts
# demo writes its PDFs and logo to the uploads bucket with the bucket's HMAC key.
resource "google_secret_manager_secret_iam_member" "migrate_seed" {
  for_each = {
    admin_password = google_secret_manager_secret.preview_admin_password.id
    s3_key_id      = "projects/${local.project}/secrets/${module.platform.secrets["S3_ACCESS_KEY_ID"]}"
    s3_secret      = "projects/${local.project}/secrets/${module.platform.secrets["S3_SECRET_ACCESS_KEY"]}"
  }
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${module.platform.migrate_service_account}"
}

# Teardown (scripts/deploy-env.sh) deletes a PR preview's objects under pr-<n>/ in the
# uploads bucket, as the deployer.
resource "google_storage_bucket_iam_member" "deployer_teardown" {
  bucket = module.platform.uploads_bucket
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.platform.deployer}"
}

# A new project already has a _Default sink; the module repoints it at the EU bucket.
import {
  to = module.platform.google_logging_project_sink.default
  id = "projects/dembrane-web-previews/sinks/_Default"
}

output "platform" {
  value = {
    project_number             = module.platform.project_number
    registry                   = module.platform.registry
    sql_connection             = module.platform.sql_connection
    workload_identity_provider = module.platform.workload_identity_provider
    deployer                   = module.platform.deployer
    uploads_bucket             = module.platform.uploads_bucket
    secrets                    = module.platform.secrets
    log_bucket                 = module.platform.log_bucket
  }
}
