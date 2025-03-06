resource "vercel_project" "portal" {
  name                       = "echo-portal"
  auto_assign_custom_domains = false
  root_directory             = "echo/frontend"

  environment = [{
    key    = "VITE_USE_PARTICIPANT_ROUTER"
    value  = "1"
    target = ["production", "preview", "development"]
  }]
}

resource "vercel_custom_environment" "portal_env_staging" {
  project_id = vercel_project.portal.id
  name       = "staging"
}

resource "vercel_project" "dashboard" {
  name                       = "echo-dashboard"
  auto_assign_custom_domains = false

  environment = [{
    key    = "VITE_USE_PARTICIPANT_ROUTER"
    value  = "0"
    target = ["production", "preview", "development"]
  }]
}

resource "vercel_custom_environment" "dashboard_env_staging" {
  project_id = vercel_project.dashboard.id
  name       = "staging"
}

# you will manually need to add domains and environment variables to the project
