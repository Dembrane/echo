resource "digitalocean_kubernetes_cluster" "doks" {
  name    = "dbr-echo-${var.env}-k8s-cluster"
  region  = var.do_region
  version = "1.32.1-do.0"
  node_pool {
    name       = "default-pool"
    size       = "s-2vcpu-4gb" # 2vCPU 4GB nodes
    auto_scale = true
    min_nodes  = 1
    max_nodes  = var.env == "prod" ? 4 : 2 # max 2 nodes for dev, 4 for prod
    tags       = ["dbr-echo", var.env, "k8s"]
  }
}

# Managed Postgres for the environment
resource "digitalocean_database_cluster" "postgres" {
  name       = "dbr-echo-${var.env}-postgres"
  engine     = "pg" # Postgres
  version    = "16" # e.g., Postgres version
  size       = var.env == "prod" ? "db-s-2vcpu-4gb" : "db-s-1vcpu-1gb"
  region     = var.do_region
  node_count = 1 # single node (for simplicity; prod could use HA with 2+ nodes)
  tags       = ["dbr-echo", var.env, "postgres"]
}

# Create an application user with a strong random password
resource "digitalocean_database_user" "app_user" {
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = "dembrane" # username
}

# Create a database in the cluster (optional, defaultdb exists by default)
resource "digitalocean_database_db" "app_db" {
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = "dembrane" # name of the database
}

resource "digitalocean_database_cluster" "redis" {
  name       = "dbr-echo-${var.env}-redis"
  engine     = "redis"
  version    = "7" # Redis version
  size       = var.env == "prod" ? "db-s-2vcpu-4gb" : "db-s-1vcpu-1gb"
  region     = var.do_region
  node_count = 1
  tags       = ["dbr-echo", var.env, "redis"]
}

resource "digitalocean_spaces_bucket" "uploads" {
  name   = "dbr-echo-${var.env}-uploads"
  region = var.do_region
}

resource "digitalocean_container_registry" "registry" {
  name                   = "dbr-cr"
  subscription_tier_slug = "basic"
  region                 = var.do_region
}
