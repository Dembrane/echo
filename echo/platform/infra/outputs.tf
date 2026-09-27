output "registry" {
  value = "${var.region}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.images.repository_id}"
}
output "sql_connection" {
  value = google_sql_database_instance.db.connection_name
}
output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}
output "deployer" {
  value = google_service_account.deployer.email
}
output "api_service_account" {
  value = google_service_account.api.email
}
output "migrate_service_account" {
  value = google_service_account.migrate.email
}
output "secrets" {
  value = merge(
    { for k, s in google_secret_manager_secret.db : k => s.secret_id },
    { for k, s in google_secret_manager_secret.storage : k => s.secret_id },
  )
}
output "uploads_bucket" {
  value = google_storage_bucket.uploads.name
}
output "worker_service_account" {
  value = google_service_account.worker.email
}
