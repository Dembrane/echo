# Migrate from DigitalOcean Redis to Valkey

## Background
DigitalOcean has announced the deprecation of their Managed Redis service in favor of Valkey, an open-source alternative to Redis. According to their [announcement](https://www.digitalocean.com/blog/introducing-managed-valkey), existing Redis databases will need to be migrated to Valkey.

## Problem
The ECHO platform currently uses Redis in several critical components:
- **Dramatiq task queue broker** for background job processing
- **Distributed locking** for the audio_lightrag ETL pipeline
- **Directus caching** (if configured)
- **Rate limiting backend** for Dramatiq

With DigitalOcean deprecating Redis, we need to update our infrastructure configurations to use Valkey instead.

## Affected Components

### 1. Environment Variables
The following environment variables need to be updated:
- `REDIS_URL` - Currently points to DigitalOcean Redis instances

### 2. Python Dependencies
- The `redis` Python client (v5.0.6) should be compatible with Valkey, but this needs verification
- Dramatiq's Redis broker should work with Valkey as it maintains Redis protocol compatibility

### 3. Connection Strings
All Redis connection strings in the deployment configurations need to be updated to point to Valkey instances.

## Proposed Solution

### Phase 1: Compatibility Testing
1. Verify that the current `redis` Python client (v5.0.6) works with Valkey
2. Test Dramatiq with Valkey to ensure task queuing works correctly
3. Verify distributed locking functionality with Valkey

### Phase 2: Infrastructure Updates
1. Update Helm charts / Kubernetes configurations to use Valkey connection strings
2. Update environment variable documentation to reflect Valkey usage
3. Update deployment documentation

### Phase 3: Migration
1. Create new Valkey instances on DigitalOcean
2. Migrate existing data from Redis to Valkey (if necessary)
3. Update production connection strings
4. Monitor for any issues

## Technical Considerations

### Compatibility
Valkey maintains Redis protocol compatibility, so minimal code changes should be required. The main changes will be:
- Connection string updates
- Documentation updates
- Potentially updating the Docker Compose development environment to use Valkey image

### Testing Requirements
- Unit tests for Redis-dependent components should pass with Valkey
- Integration tests for Dramatiq task processing
- Load testing for distributed locking under concurrent access

## Action Items
- [ ] Research Valkey compatibility with current Redis client version
- [ ] Update development environment (docker-compose.yml) to use Valkey
- [ ] Test all Redis-dependent features with Valkey
- [ ] Update deployment configurations (Helm charts)
- [ ] Create migration plan for production data
- [ ] Update documentation

## References
- [DigitalOcean Valkey Announcement](https://www.digitalocean.com/blog/introducing-managed-valkey)
- [Valkey Project](https://github.com/valkey-io/valkey)

## Priority
**High** - This needs to be addressed before DigitalOcean fully deprecates their Redis service.

## Labels
- infrastructure
- breaking-change
- migration
- high-priority