output "db_uri" {
  value       = digitalocean_database_cluster.postgres.uri
  description = "Postgres connection URI"
  sensitive   = true
}

output "redis_uri" {
  value       = digitalocean_database_cluster.redis.uri
  description = "Redis connection URI"
  sensitive   = true
}

output "registry_url" {
  value       = digitalocean_container_registry.registry.endpoint
  description = "Container registry URL"
}

// spaces output
// ams3.digitaloceanspaces.com
// bucket name (dev)  : dbr-echo-dev-uploads.ams3.digitaloceanspaces.com
// bucket name (prod) : dbr-echo-prod-uploads.ams3.digitaloceanspaces.com

output "vercel_dashboard_project_id" {
  value = vercel_project.dashboard.id
}

output "vercel_dashboard_staging_environment_id" {
  value = vercel_custom_environment.dashboard_env_staging.id
}

output "vercel_portal_project_id" {
  value = vercel_project.portal.id
}

output "vercel_portal_staging_environment_id" {
  value = vercel_custom_environment.portal_env_staging.id
}
