# The preview environment, alone in GCP project dembrane-web-previews. Its state lives in a bucket
# in the same project (made by ../bootstrap.sh), and nothing here holds a role anywhere else.
terraform {
  required_version = ">= 1.9"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
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
