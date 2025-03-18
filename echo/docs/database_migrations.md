# Database Migrations

These are handled through the [directus-sync](https://github.com/tractr/directus-sync) extension on Directus running on the PostgreSQL database.

1. CD into directus folder (../echo/directus)

2. **Run** the sync command in the dev container terminal or a WSL terminal inside "echo > directus" directory:

```bash
./sync.sh
```

and follow the instructions.

## TODO

- [ ] Add script to run "pgvector" columns