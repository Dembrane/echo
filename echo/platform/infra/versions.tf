terraform {
  required_version = ">= 1.9"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # One state per environment: terraform init -backend-config="prefix=platform/<env>"
  backend "gcs" {
    bucket = "dbr-gcp-echo-tf-state"
  }
}

provider "google" {
  project = var.project
  region  = var.region
}
