# Infrastructure

One Terraform state per environment in `gs://dbr-gcp-echo-tf-state/platform/<env>`.

```
terraform init -backend-config="prefix=platform/preview"
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) terraform apply -var-file=preview.tfvars
```

Services and jobs are rolled out by `.github/workflows/platform.yml` with the image built
from the commit; Terraform owns everything around them: registry, database, logins,
secrets, identities and the keyless GitHub trust.
