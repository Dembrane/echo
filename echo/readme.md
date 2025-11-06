# Dembrane 

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

# How do I run Dembrane locally?

Dembrane is a application with multiple services and dependencies. 

The following guide is to run the whole application locally. it is HIGHLY recommended to use [dev containers](https://containers.dev/) for development to properly configure and manage these services and dependencies.

> TIP: If you only want to run the frontend, you can use the [frontend_getting_started.md](./docs/frontend_getting_started.md).

> TIP: Running into any issues? Are you using Windows? Check the FAQs or [troubleshooting section at the end of this doc](#troubleshooting) and search through the issues tab.

## Prerequisites:

- VS Code (or Cursor) with "Dev Containers" Extension installed
- Docker Desktop
- WSL (recommended if you are on Windows)

## Steps:

1. Open the `/echo/echo` folder in a Dev Container

	- Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> to open the command palette.
	- Type **"Dev Containers: Open Folder in Container"** (or "Reopen in Container").
	- Choose the `/echo/echo` folder (this is the folder containing the `.devcontainer/` folder)
	- Wait for the containers to build. This will take a few minutes.

1. This installs the following:

	- Devcontainer with `pnpm`, `uv` installed and configured (see [devcontainer.json](.devcontainer/devcontainer.json) for more context)
	- Postgres database running and exposed on port 5432
	- Redis instance
	- Directus server running and exposed on port 8055

1. For your S3-compatible storage you can either
	-  bring your own S3 backend
	- or use the `.devcontainer/docker-compose-s3.yml` file to spin up a Minio server exposed on port 9001. 

	In both cases you need to configure in `server/.env` and `directus/.env`. We are working on providing an configurable alternative to store files via local storage instead of S3. PRs are welcome to make this flow better.


1. Configure `.env` files

	- Most .env variables are already setup through the devcontainer.
	- You can override any of them by setting the corresponding environment variable in the `.env` file, you can see what variables are needed in the `.env.sample` files.
	- For the server: update `server/.env`
	- For the frontends: update `frontend/.env`
	- For directus, update `directus/.env` (For directus, you might need to restart your docker container to load the keys)

1. Run the [database migrations](./docs//database_migrations.md)

1. (Optional) Use the "Terminal Keeper" Extension for opening the relevant terminals from the container. (see [.vscode/sesssions.json](.vscode/sessions.json) for the exact commands run when the terminals are opened)

	- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> to open the command palette.
	- Type **"Active session"**.
	- Click **"Terminal Keeper: Active session"**.

## FAQ [./docs/troubleshooting-tips.md](./docs/troubleshooting-tips.md)

Enjoy building with Dembrane!