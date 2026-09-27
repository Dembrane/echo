# 0004 The baseline is main; schema cleanup comes after

**Decision.** The first migration is echo main's schema, introspected with drizzle-kit
and corrected (operator classes, unsized vector, extension views), with guard functions
and triggers carried verbatim. Main ships to prod first as usual; the platform cuts over
from that state. Pruning and renames are later migrations, expand then contract.

**Why.** Old and new can run on the same data, which is what makes parity testing and a
reversible cutover possible. A fresh schema would make cutover a one-way data move with
real recordings in it.

**Proof.** `packages/db/scripts/schema-roundtrip.sh` rebuilds echo-next's schema from the
chain object for object (1,909 objects, index names and triggers included).

**Against.** The baseline carries Directus-era shapes (app_user next to directus_users,
junction tables named `_1`). They are cleaned up deliberately in the prune list, not
silently in the move.
