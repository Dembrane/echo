#!/usr/bin/env bash
# The two things Terraform cannot do for an environment's project, run once before the
# first `terraform init` in infra/<env>:
#   1. the state bucket, in the project it describes: versioned, europe-west4, no public access;
#   2. APIs switched off: Cloud Trace and Telemetry (spans would leave the EU), and the
#      defaults a new project comes with that the platform never calls.
# Safe to rerun.
#   infra/bootstrap.sh <preview|next|prod>
set -euo pipefail

case "${1:-}" in
  preview) project=dembrane-web-previews ;;
  next) project=dembrane-web-next ;;
  prod) project=dembrane-web-prod ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
bucket=gs://$project-tf-state

if ! gcloud storage buckets describe "$bucket" --project "$project" >/dev/null 2>&1; then
  gcloud storage buckets create "$bucket" --project "$project" --location europe-west4 \
    --uniform-bucket-level-access --public-access-prevention
fi
gcloud storage buckets update "$bucket" --versioning >/dev/null

off=(
  cloudtrace.googleapis.com
  telemetry.googleapis.com
  analyticshub.googleapis.com
  apptopology.googleapis.com
  bigqueryconnection.googleapis.com
  bigquerydatapolicy.googleapis.com
  bigquerydatatransfer.googleapis.com
  bigquerymigration.googleapis.com
  bigqueryreservation.googleapis.com
  bigquerystorage.googleapis.com
  dataform.googleapis.com
  dataplex.googleapis.com
  datastore.googleapis.com
  bigquery.googleapis.com
)
enabled=$(gcloud services list --enabled --project "$project" --format 'value(config.name)')
for api in "${off[@]}"; do
  if grep -qx "$api" <<<"$enabled"; then
    gcloud services disable "$api" --project "$project" --force --quiet
  fi
done
echo "$project: state in $bucket; Trace, Telemetry and unused defaults off"
