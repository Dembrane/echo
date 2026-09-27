locals {
  name = "echo-${var.env}"
  apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudtrace.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

# ── Images ────────────────────────────────────────────────────────────────
resource "google_artifact_registry_repository" "images" {
  repository_id = local.name
  location      = var.region
  format        = "DOCKER"
  description   = "Images for the ${var.env} environment of the echo platform."
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions { keep_count = 30 }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition { older_than = "2592000s" }
  }
  depends_on = [google_project_service.apis]
}

# ── Database ──────────────────────────────────────────────────────────────
resource "google_sql_database_instance" "db" {
  name                = local.name
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true
  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = var.env == "prod" ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
    }
    insights_config {
      query_insights_enabled = true
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    ip_configuration {
      ipv4_enabled = true # reached only through the Cloud Run connector, which authenticates with IAM
      ssl_mode     = "ENCRYPTED_ONLY"
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "echo" {
  name     = "echo"
  instance = google_sql_database_instance.db.name
}

# Owner runs migrations (DDL). The app login gets data rights only, granted by the
# migration job, so a compromised API cannot alter the schema.
resource "random_password" "owner" {
  length  = 40
  special = false
}
resource "random_password" "app" {
  length  = 40
  special = false
}
resource "google_sql_user" "owner" {
  name     = "echo_owner"
  instance = google_sql_database_instance.db.name
  password = random_password.owner.result
}
resource "google_sql_user" "app" {
  name     = "echo_app"
  instance = google_sql_database_instance.db.name
  password = random_password.app.result
}

locals {
  socket = "/cloudsql/${google_sql_database_instance.db.connection_name}"
  urls = {
    DATABASE_URL           = "postgres://echo_app:${random_password.app.result}@localhost/echo?host=${local.socket}"
    MIGRATION_DATABASE_URL = "postgres://echo_owner:${random_password.owner.result}@localhost/echo?host=${local.socket}"
  }
}

# ── Secrets ───────────────────────────────────────────────────────────────
resource "google_secret_manager_secret" "db" {
  for_each  = local.urls
  secret_id = "${local.name}-${lower(replace(each.key, "_", "-"))}"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}
resource "google_secret_manager_secret_version" "db" {
  for_each    = local.urls
  secret      = google_secret_manager_secret.db[each.key].id
  secret_data = each.value
}

# ── Identities ────────────────────────────────────────────────────────────
resource "google_service_account" "api" {
  account_id   = "${local.name}-api"
  display_name = "echo ${var.env} API runtime"
}
resource "google_service_account" "migrate" {
  account_id   = "${local.name}-migrate"
  display_name = "echo ${var.env} migration job"
}
resource "google_service_account" "deployer" {
  account_id   = "${local.name}-deployer"
  display_name = "echo ${var.env} deploys from GitHub Actions"
}

resource "google_project_iam_member" "api" {
  for_each = toset(["roles/cloudsql.client", "roles/cloudtrace.agent", "roles/aiplatform.user", "roles/monitoring.metricWriter"])
  project  = var.project
  role     = each.value
  member   = google_service_account.api.member
}
resource "google_project_iam_member" "migrate" {
  project = var.project
  role    = "roles/cloudsql.client"
  member  = google_service_account.migrate.member
}
resource "google_secret_manager_secret_iam_member" "api_db" {
  secret_id = google_secret_manager_secret.db["DATABASE_URL"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.api.member
}
resource "google_secret_manager_secret_iam_member" "migrate_db" {
  secret_id = google_secret_manager_secret.db["MIGRATION_DATABASE_URL"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.migrate.member
}

# The deployer pushes images and rolls out services and jobs as the runtime identities.
resource "google_project_iam_member" "deployer" {
  for_each = toset(["roles/run.developer"])
  project  = var.project
  role     = each.value
  member   = google_service_account.deployer.member
}
resource "google_artifact_registry_repository_iam_member" "deployer" {
  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.deployer.member
}
resource "google_service_account_iam_member" "deployer_acts_as" {
  for_each           = { api = google_service_account.api.name, migrate = google_service_account.migrate.name }
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}

# ── Keyless deploys from GitHub ───────────────────────────────────────────
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${local.name}-github"
  display_name              = "GitHub ${var.env}"
  depends_on                = [google_project_service.apis]
}
resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  attribute_condition = "assertion.repository == '${var.github_repo}' && assertion.ref == '${var.deploy_ref}'"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
