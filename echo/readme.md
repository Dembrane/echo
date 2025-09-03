# Dembrane ECHO

![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/Dembrane/echo?utm_source=oss&utm_medium=github&utm_campaign=Dembrane%2Fecho&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)

## Architecture

Data Storage:

- PostgreSQL Database
- Redis (used by celery and directus)
- S3 Compatible Object Storage (used for user assets)

Service:

- Directus (CMS, Auth Server)
- Python FastAPI Backend (AI APIs, chat, library, transcription etc)

Clients:

- React Frontends (Admin Dashboard and Participants' Portal, used Directus / Python)

## Getting Started

# How do I run Dembrane ECHO locally?

Dembrane ECHO is a application with multiple services and dependencies. 

The following guide is to run the whole application locally. it is recommended to use [dev containers](https://containers.dev/) for development to properly configure and manage these services and dependencies.

> TIP: If you only want to run the frontend, you can use the [frontend_getting_started.md](./docs/frontend_getting_started.md).

> TIP: Running into any issues? Are you using Windows? Check the FAQs or [troubleshooting section at the end of this doc](#troubleshooting) and search through the issues tab.

## Prerequisites:

- VS Code (or Cursor) with "Dev Containers" Extension installed
- Docker Desktop
- WSL (strongly recommended if you are on Windows)

## Steps:

1. Open the `/echo/echo` folder in a Dev Container

	- Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> to open the command palette.
	- Type **"Dev Containers: Open Folder in Container"** (or "Reopen in Container").
	- Choose the `/echo/echo` folder (this is the folder containing the `.devcontainer/` folder)
	- Wait for the containers to build. This will take a few minutes.

1. This installs the following:

	- Devcontainer with `pnpm`, `rye` installed and configured (see [devcontainer.json](.devcontainer/devcontainer.json) for more context)
	- Postgres database running and exposed on port 5432
	- Redis instance
	- Minio server running and exposed on port 9001
	- Directus server running and exposed on port 8055

1. Configure `.env` files

	- Most .env variables are already setup through the devcontainer.
	- You can override any of them by setting the corresponding environment variable in the `.env` file, you can see what variables are needed in the `.env.sample` files.
	- For the server: update `server/.env`
	- For the frontends: update `frontend/.env`
	- For directus, it is not straight-forward to update the env (PRs are welcomed). Preferred way would be to add a .env file to `directus/` and have it load inside the container using `.devcontainer/docker-compose.yml`

1. Run the [database migrations](./docs//database_migrations.md)

1. (Optional) Use the "Terminal Keeper" Extension for opening the relevant terminals from the container. (see [.vscode/sesssions.json](.vscode/sessions.json) for the exact commands run when the terminals are opened)

	- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> to open the command palette.
	- Type **"Active session"**.
	- Click **"Terminal Keeper: Active session"**.

## FAQ

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

### Redis not starting (Docker Desktop)

`Can't open the append-only file: Permission denied`

If your Redis container fails to start and you see a “Permission denied” error about the append-only file, you may need to change permissions on the Redis data folder.

1. **Open a local WSL terminal** (outside of the container).
2. **Run**:
   ```bash
   sudo chown -R 1001:1001 ./echo/.devcontainer/redis_data
   ```
3. **Restart** the redis container from Docker Desktop.

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


Enjoy building with Dembrane Echo!
