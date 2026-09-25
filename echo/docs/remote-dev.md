# Remote development on GCP

Runs the devcontainer stack on a rented VM instead of a laptop. The scripts
live in [`scripts/remote-dev/`](../scripts/remote-dev/README.md); that README is
the command reference. This page covers the reasoning, the editor setup, and
the optional DevPod layer.

## Why

The local stack is 5 containers (postgres+pgvector, valkey, directus, agent,
and the devcontainer shell) plus the 7 host processes in `mprocs.yaml`: uvicorn,
three dramatiq workers on separate queues, the scheduler, and two vite dev
servers. That is a lot for a laptop, particularly one that is also running a
browser and an editor.

Moving it to a VM changes nothing about the stack. The same
`.devcontainer/docker-compose.yml` and the same `.devcontainer/setup.sh` run,
and `mprocs` works as it always did. Only the hardware moves.

## Prerequisites

- `gcloud` CLI, authenticated: `gcloud auth login`
- A GCP project with billing enabled, in the `dembrane.com` org
- Zed, VS Code, or any SSH client

## Setup

```sh
cd echo/scripts/remote-dev
./init.sh && ./create.sh && ./up.sh
```

`init.sh` asks which project and zone to use and writes them to `local.env`,
which is gitignored. Personal values are never committed; only team-wide
defaults live in `config.sh`.

Pick the zone closest to **you**, not closest to production. SSH round-trip
time is the single biggest factor in how a remote editor feels, and it has
nothing to do with where the app is deployed.

## Editor setup

### Zed

Zed's remote development runs the server side over SSH, which means the
language servers in `.zed/settings.json` (ruff, ty, biome) execute on the
remote machine. Connect to the **container**, not the VM, so those servers see
the same `uv` environment and `node_modules` as the code.

1. `cmd-shift-P`, "projects: open remote"
2. Add host: `dembrane-devcontainer`
3. Open path: `/workspaces/echo`

`ssh-config.sh` has already written that host into `~/.ssh/config`, with a
`ProxyJump` through the VM.

### VS Code / Cursor

Two options:

- **Remote-SSH** to `dembrane-devcontainer`, same as Zed. Simple, and the extension
  list in `devcontainer.json` does not install automatically.
- **Remote-SSH to `dembrane-devbox`, then "Reopen in Container"**. Slower to start,
  but this path does honour `devcontainer.json`, so the extensions and
  `portsAttributes` come along.

### Plain terminal

```sh
./ssh.sh                      # shell in the container, at /workspaces/echo
./ssh.sh --vm                 # shell on the VM
./ssh.sh uv run pytest        # one-shot command in the container
```

## Ports

`./tunnel.sh` forwards the dev ports to your laptop over SSH and stays in the
foreground. Leave it in its own terminal tab.

| Local | Service |
|---|---|
| 5173 | admin dashboard (`admin@dembrane.com` / `admin`) |
| 5174 | participant portal |
| 8000 | backend API (`/docs` for the OpenAPI UI) |
| 8055 | directus (`admin@dembrane.com` / `admin`) |
| 5432 | postgres (`dembrane` / `dembrane`) |
| 9000, 9001 | minio S3 API and console, if enabled (`dembrane` / `dembrane`) |

The mapping is 1:1 on purpose. `docker-compose.yml` hardcodes localhost origins:

```yaml
- PUBLIC_URL=http://localhost:8055
- CORS_ORIGIN=http://localhost:5173,http://localhost:5174
- USER_INVITE_URL_ALLOW_LIST=http://localhost:5173/invite
```

Keeping the same port numbers on your laptop means none of that needs a remote
variant, and directus sessions, cookies and CORS behave exactly as they do
locally. It also keeps every service off the public internet: the GCP firewall
opens port 22 and nothing else.

## Cost control

This is the part that bites. A running `e2-standard-4` is roughly $100/month.
Stopped, you pay only for the disk, around $6/month for the default 50GB.

```sh
./stop.sh    # end of day
./start.sh   # next morning
```

Stopping keeps everything on disk: the repo, uncommitted work, docker images,
`node_modules`, the postgres data directory. Only `destroy.sh` throws work away,
and it makes you type the instance name first.

Start on `e2-standard-4` and upsize only when it hurts. Machine type is not
baked into the disk, so moving up takes about a minute and loses nothing:

```sh
./resize.sh e2-standard-8
./up.sh                     # containers do not survive the reboot
```

## Optional: DevPod

The scripts above are deliberately plain: `gcloud`, `ssh`, `docker compose`,
all readable and all in the repo. [DevPod](https://devpod.sh) is a layer on top
that reads `devcontainer.json` directly and manages provisioning itself, so
`devpod up` replaces `create.sh` and `up.sh`.

It is worth adding once the VM path is proven, not before. Two reasons to wait:

- DevPod's compose-based devcontainer support is more fragile than its
  single-container support, and this repo uses `dockerComposeFile`.
- When something breaks, debugging the plain scripts means reading bash.
  Debugging DevPod means reading DevPod.

If you do want it:

```sh
brew install devpod
devpod provider add gcloud
devpod provider use gcloud --option GCLOUD_PROJECT=<your project> \
                           --option GCLOUD_ZONE=<your zone> \
                           --option MACHINE_TYPE=e2-standard-4 \
                           --option DISK_SIZE=100
devpod up . --ide none
devpod ssh --configure-ssh  # writes a host entry Zed can use
```

Two things still need doing by hand, because DevPod does not know about them:

- The gitignored `.env` files. `sync-env.sh` handles this for the script path;
  under DevPod you copy them up yourself.
- `setup.sh` runs as `postCreateCommand`, which DevPod does honour, so that part
  is free.

Keep `stop.sh` in mind either way. `devpod stop` is the equivalent, and
forgetting it costs the same.

## Related

- [`scripts/remote-dev/README.md`](../scripts/remote-dev/README.md), command reference
- [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json)
- [`mprocs.yaml`](../mprocs.yaml), the dev process list
