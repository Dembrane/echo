locals {
  name = "echo-${var.env}"
  apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

# ── Scaling rules ─────────────────────────────────────────────────────────
# The deploy workflow reads var.services from the same tfvars file; these hold each
# environment to its shape at plan time.
resource "terraform_data" "scaling_rules" {
  lifecycle {
    precondition {
      condition     = var.env != "preview" || alltrue([for s in values(var.services) : s.max <= 1])
      error_message = "preview runs at most one instance of every service."
    }
    precondition {
      condition     = var.env != "preview" || alltrue([for k, s in var.services : s.min == 0 if k != "worker"])
      error_message = "preview keeps no warm instances."
    }
    precondition {
      condition     = var.env != "next" || alltrue([for k in ["api", "dashboard", "portal", "worker"] : var.services[k].min == 2 && var.services[k].max == 2])
      error_message = "next runs exactly two instances of the API, dashboard, portal and worker."
    }
    precondition {
      condition     = var.env != "prod" || (var.services["api"].min >= 2 && var.services["portal"].min >= 2)
      error_message = "prod keeps at least two warm API and portal instances."
    }
  }
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
    # Explicit, so the connection budget check (packages/config capacity.ts) reads the limit
    # the server enforces rather than a default that moves with the tier.
    database_flags {
      name  = "max_connections"
      value = tostring(var.db_max_connections)
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
resource "google_service_account" "worker" {
  account_id   = "${local.name}-worker"
  display_name = "echo ${var.env} worker runtime"
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
  for_each = toset(["roles/cloudsql.client", "roles/aiplatform.user", "roles/monitoring.metricWriter"])
  project  = var.project
  role     = each.value
  member   = google_service_account.api.member
}
resource "google_project_iam_member" "worker" {
  for_each = toset(["roles/cloudsql.client", "roles/aiplatform.user", "roles/monitoring.metricWriter"])
  project  = var.project
  role     = each.value
  member   = google_service_account.worker.member
}
resource "google_secret_manager_secret_iam_member" "worker_db" {
  secret_id = google_secret_manager_secret.db["DATABASE_URL"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.worker.member
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
  # run.admin, not run.developer: making the API reachable sets its IAM policy.
  for_each = toset(["roles/run.admin"])
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
  for_each           = { api = google_service_account.api.name, worker = google_service_account.worker.name, migrate = google_service_account.migrate.name }
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
    "google.subject"        = "assertion.sub"
    "attribute.repository"  = "assertion.repository"
    "attribute.ref"         = "assertion.ref"
    "attribute.environment" = "assertion.environment"
  }
  # The environment's branch deploys, and on preview also jobs in the PR preview GitHub
  # environment, which run from PR refs. Fork PRs get no OIDC token, so only branches in
  # this repository can reach it; the environment's protection rules gate who may.
  attribute_condition = var.pr_preview_environment == null ? "assertion.repository == '${var.github_repo}' && assertion.ref == '${var.deploy_ref}'" : "assertion.repository == '${var.github_repo}' && (assertion.ref == '${var.deploy_ref}' || assertion.environment == '${var.pr_preview_environment}')"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# ── Auth ──────────────────────────────────────────────────────────────────
# Signs sessions. Rotating it (taint and apply) signs everyone out.
resource "random_password" "auth_secret" {
  length  = 64
  special = false
}
resource "google_secret_manager_secret" "auth_secret" {
  secret_id = "${local.name}-auth-secret"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
}
resource "google_secret_manager_secret_version" "auth_secret" {
  secret      = google_secret_manager_secret.auth_secret.id
  secret_data = random_password.auth_secret.result
}
resource "google_secret_manager_secret_iam_member" "api_auth_secret" {
  secret_id = google_secret_manager_secret.auth_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.api.member
}

# The web servers serve static files and forward /api; they need no secrets or data access.
resource "google_service_account" "web" {
  account_id   = "${local.name}-web"
  display_name = "echo ${var.env} dashboard and portal"
}
resource "google_service_account_iam_member" "deployer_acts_as_web" {
  service_account_id = google_service_account.web.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}

# Signs invite links. Must equal Directus's SECRET wherever Directus-era invite links are
# still in inboxes (next, prod) until cutover; the preview has none, so it is random.
resource "random_password" "invite_hash_secret" {
  length  = 64
  special = false
}
resource "google_secret_manager_secret" "invite_hash_secret" {
  secret_id = "${local.name}-invite-hash-secret"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
}
resource "google_secret_manager_secret_version" "invite_hash_secret" {
  secret      = google_secret_manager_secret.invite_hash_secret.id
  secret_data = random_password.invite_hash_secret.result
}
resource "google_secret_manager_secret_iam_member" "api_invite_hash_secret" {
  secret_id = google_secret_manager_secret.invite_hash_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.api.member
}
