### How do I add python dependencies?

See [server_adding_dependencies.md](./docs/server_adding_dependencies.md)

### How do I use the `style-guides`?

Attach @<the style guide name> to the cursor chat. See [./meta.md](./meta.md) for more context.

### Can I develop/run only the frontend?

See [frontend_getting_started.md](./docs/frontend_getting_started.md)

### How do I add translations for the frontend?

See [frontend_translations.md](./docs/frontend_translations.md)


## Troubleshooting

### Directus not starting (Docker Desktop)

If the Directus container does not start, this could be due to the database not being ready yet.

1. **Open Docker Desktop** → **Containers**.
2. **Restart** the Directus container.
3. Ensure you have run the [Database Migrations](./docs/database_migrations.md)

### Directus invalid password?

If you try logging into directus and it doesn't work with what you have in the .env file.

Solution: You need to reset the DB. (delete ".devcontainer/postgres_data" and rebuild / migrate the DB again / etc)

### Redis/Valkey not starting (Docker Desktop)

`Can't open the append-only file: Permission denied`
`redis.exceptions.ResponseError: MISCONF Valkey is configured to save RDB snapshots, but it's currently unable to persist to disk. Commands that may modify the data set are disabled, because this instance is configured to report errors during writes if RDB snapshotting fails (stop-writes-on-bgsave-error option). Please check the Valkey logs for details about the RDB error.`

If your Redis/Valkey container fails to start and you see a “Permission denied” error about the append-only file, you may need to change permissions on the Redis data folder.

0. First make sure that the folder `.devcontainer/redis_data` exists

1. **Open a local WSL terminal** (outside of the container).
2. **Run**:
   ```bash
   sudo chown -R 1001:1001 .devcontainer/redis_data
   ```
3. **Restart** the redis container from Docker Desktop.

### Able to login, "Error creating Project"

- do [Database Migrations](./docs/database_migrations.md)

### Minio not starting 

- Go to minio-ui at http://localhost:9001/
- Login with credentials from [.devcontainer/docker-compose.yml](.devcontainer/docker-compose.yml)
- Create a bucket called "dembrane"

### Frontends stuck on reloading

`The file does not exist at "node_modules/.vite/deps/chunk\*" which is in the optimize deps directory.`

- https://github.com/vitejs/vite/discussions/17738
- fix is to disable cache in the network tab in the browser

### Fix for mypy extension hung up (devcontainer hang/lag)

```bash
ps -aux | grep "mypy"
# grab all the process ids
kill -9 <process ids seperated by spaces>
```

### (Windows Specific) Issues with the default WSL distribution that comes with Docker Desktop

**Enable WSL Integration in Docker Desktop**
   - Open Docker Desktop.
   - Click the cog/settings icon, then go to **Resources** → **WSL Integration**.
   - Toggle on the distribution (e.g., “Ubuntu-22.04”) that you want Docker to use.

### Docker Desktop Container Crashing

In case docker desktop crashes/ runs out of memory/ IDE freezes, try these steps: 
- Increase allocates RAM to WSL[https://fizzylogic.nl/2023/01/05/how-to-configure-memory-limits-in-wsl2]
- Reduce mypy load by excluding files[https://github.com/python/mypy/issues/17105]
- Uninstall mypy

## Additional Tips

1. **Check Docker Resources**

   - Make sure Docker has enough memory/CPU allocated under **Docker Desktop** → **Settings** → **Resources**.

2. **Handling Port Conflicts**

   - If ports like `8055` are in use, either stop the conflicting service or update the Directus port in your Docker Compose file.

3. **Persistence**

   - Docker volumes or the `.devcontainer/redis_data` folder store data. If you remove them, you may lose data. Make backups if necessary.

4. **Running Commands Outside vs. Inside Dev Container**
   - Typically, build/test/development commands run inside the dev container.
   - Docker-level commands (like `docker compose` or `sudo chown` for folder permissions) sometimes must be run in your **local WSL terminal**, depending on how your dev container is configured.


