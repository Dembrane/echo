# Database Migrations

These are handled through the [directus-sync](https://github.com/tractr/directus-sync) extension on Directus running on the PostgreSQL database.

1. CD into directus folder (../echo/directus)

2. **Run** the sync command in the dev container terminal or a WSL terminal inside "echo > directus" directory:

```bash
./sync.sh
```

and follow the instructions.

3. Run the SQL script on the machine

CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE quote ADD COLUMN IF NOT EXISTS embedding vector;
ALTER TABLE aspect ADD COLUMN IF NOT EXISTS centroid_embedding vector;