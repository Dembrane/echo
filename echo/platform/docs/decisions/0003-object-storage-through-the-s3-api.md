# 0003 Object storage through the S3 API

**Decision.** The `storage` package uses Bun's built-in S3 client against a GCS bucket via
GCS's S3 interoperability (HMAC key in Secret Manager). Locally a filesystem
implementation stands in behind the same interface; one contract suite runs against both.
At cutover, Storage Transfer Service copies the Spaces buckets into GCS.

**Why.** The S3 API runs unchanged on GCS, DigitalOcean Spaces, MinIO, OVH and Hetzner, so
moving clouds later is a configuration change. No SDK dependency.

**Against.** GCS's S3 compatibility has gaps (multipart details, some presign options).
Presigned PUT and GET are tested against the real bucket before anything depends on them;
if a gap bites, a native GCS implementation fits behind the same interface.
