env        = "preview"
deploy_ref = "refs/heads/feat/bun-migration"
# The preview runs on Cloud Run URLs until it takes over echo-next's domains.
browser_origins = ["http://localhost:5173", "http://localhost:5174"]
