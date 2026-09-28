# The next environment, alone in GCP project dembrane-web-next. Its state lives in a bucket
# in the same project (made by ../bootstrap.sh), and nothing here holds a role anywhere else.
terraform {
  required_version = ">= 1.9"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "gcs" {
    bucket = "dembrane-web-next-tf-state"
  }
}

locals {
  project  = "dembrane-web-next"
  settings = jsondecode(file("${path.module}/../next.tfvars.json"))
  # Filled by hand before the first deploy; see infra/README.md.
  pending_secrets = [
    "AGENT_CLIENT_SECRET_KEY",
    "AUTH_GOOGLE_CLIENT_SECRET",
    "SENDGRID_API_KEY",
    "MOLLIE_API_KEY",
    "ECHO_SUPPORT_WEBHOOK_TOKEN",
    "SITE_API_TOKEN",
    "ACCOUNTS_SLACK_WEBHOOK_URL",
    "ACCOUNTS_EVENTS_SECRET",
  ]
}

provider "google" {
  project = local.project
  region  = "europe-west4"
}

module "platform" {
  source                      = "../modules/platform"
  project                     = local.project
  env                         = local.settings.env
  deploy_ref                  = local.settings.deploy_ref
  browser_origins             = local.settings.browser_origins
  db_tier                     = local.settings.db_tier
  db_max_connections          = local.settings.db_max_connections
  db_environments             = lookup(local.settings, "db_environments", 1)
  services                    = local.settings.services
  alert_email                 = lookup(local.settings, "alert_email", null)
  generate_invite_hash_secret = false
  pending_secrets             = local.pending_secrets
  monitor_api_ready           = false # until the first deploy
  monitor_worker_ready        = false # until the first deploy
}

# A new project already has a _Default sink; the module repoints it at the EU bucket.
import {
  to = module.platform.google_logging_project_sink.default
  id = "projects/dembrane-web-next/sinks/_Default"
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
