# Database Migrations

These are handled through the [directus-sync](https://github.com/tractr/directus-sync) extension on Directus running on the PostgreSQL database.

1. CD into directus folder (../echo/directus)

2. **Run** the sync command in the dev container terminal or a WSL terminal inside "echo > directus" directory:

```bash
1. run command: ./sync.sh
2. choose option 1: push
```

3. Run the SQL script on the machine

`psql -h postgres -p 5432 -U dembrane`

- default password is dembrane if you're using the dev container

```bash
CREATE extension vector;
```