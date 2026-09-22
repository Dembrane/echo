# Remote dev VM

Runs the devcontainer stack on a GCP VM instead of your laptop, and connects
Zed (or VS Code, or plain SSH) to it. Use this when the local machine cannot
comfortably run 5 containers plus 7 dev processes at once.

Nothing about the stack changes. The same `.devcontainer/docker-compose.yml`
and the same `.devcontainer/setup.sh` run, just on rented hardware.

## Quick start

```sh
cd echo/scripts/remote-dev

./init.sh          # asks which GCP project and zone; writes local.env
./create.sh        # creates the VM, installs docker, clones the repo
./up.sh            # copies .env files up, starts the stack, installs deps
./ssh-config.sh    # adds the SSH hosts Zed connects through
```

Then, in a terminal tab you leave open:

```sh
./tunnel.sh        # forwards 5173, 5174, 8000, 8055, 5432 to localhost
```

And in Zed: `cmd-shift-P`, "projects: open remote", host `dembrane-devcontainer`,
path `/workspaces/echo`.

Start the dev processes the same way you would locally:

```sh
./ssh.sh
cd /workspaces/echo && mprocs
```

The app ports stay empty until mprocs is running, and the first load can take a
few minutes while vite pre-bundles. Log in at http://localhost:5173 with
`admin@dembrane.com` / `admin`, the directus admin that `docker-compose.yml`
creates on first boot. There is no demo data: projects and conversations start
empty.

## Daily loop

```sh
./start.sh     # boot the VM, refresh the SSH config
./up.sh        # bring the containers back
./tunnel.sh    # forward ports (leave running)
# ... work ...
./stop.sh      # when you are done
```

`./stop.sh` matters. A running `e2-standard-4` is roughly $100/month; stopped,
you pay only for the 50GB disk, which is about $6/month. The disk keeps
everything: the repo, uncommitted work, docker images, `node_modules`, the
postgres data directory.

## Commands

| Script | What it does |
|---|---|
| `init.sh` | First-run setup. Prompts for project, zone, size. Writes `local.env`. |
| `create.sh` | Creates the VM, installs docker, clones the repo. Idempotent. |
| `up.sh` | Syncs `.env` files, `docker compose up -d --build`, runs `setup.sh`, installs your SSH key. |
| `down.sh` | Stops containers, leaves the VM up. |
| `start.sh` / `stop.sh` | VM power. `stop.sh` shuts containers down cleanly first. |
| `status.sh` | VM state, container state, memory, disk, load, tunnel check. |
| `resize.sh` | `./resize.sh e2-standard-8` or `./resize.sh --disk 200GB`. |
| `ssh.sh` | Shell in the devcontainer. `--vm` for the host instead. |
| `ssh-config.sh` | Writes the `~/.ssh/config` block. `--remove` to clean up. |
| `tunnel.sh` | Port forwards. Foreground, ctrl-c to close. |
| `sync-env.sh` | Re-copies the gitignored `.env` files up. |
| `destroy.sh` | Deletes the VM and disk. Asks you to type the name. |

## How it fits together

```
your laptop                    GCP VM (ubuntu 24.04)
-----------                    ---------------------
Zed  ──ssh──┐                  ┌─ docker compose ─────────────┐
            │  port 22         │  postgres  valkey  directus  │
tunnel.sh ──┴────────────────► │  agent                       │
                               │  devcontainer ── sshd :22 ───┼─┐
                               │    /workspaces/echo          │ │
                               └──────────────────────────────┘ │
                                        published on VM :2222 ◄─┘
```

Two SSH host entries get written:

- `dembrane-devbox` reaches the VM. Useful for `docker` commands and logs.
- `dembrane-devcontainer` reaches the container, by `ProxyJump` through the VM.

Zed connects to `dembrane-devcontainer`. That is what puts the language servers
from `.zed/settings.json` (ruff, ty, biome) and the toolchain (uv, pnpm, node
22) in the same place as the code.

## Security posture

- The GCP firewall only ever opens **port 22**. Nothing else is reachable from
  the internet.
- The devcontainer's sshd on port 2222 is published on the VM only. It is
  reached by jumping through the VM's own sshd, so an attacker would need to
  get onto the VM first.
- App ports (5173, 8000, 8055, 5432) travel inside the SSH tunnel and bind to
  your laptop's loopback. They are never exposed.
- `setup.sh` sets a default container root password (`dembrane`). `up.sh`
  installs your public key so you do not depend on it, but the password is
  still set. This is acceptable only because 2222 is not publicly reachable.

Ports are forwarded 1:1 on purpose. `docker-compose.yml` hardcodes localhost
origins (`CORS_ORIGIN=http://localhost:5173`, `PUBLIC_URL=http://localhost:8055`,
the invite and password-reset allow-lists), so identical port numbers on both
ends mean none of that config needs a remote variant, and directus sessions and
CORS behave exactly as they do on a laptop.

## Configuration

`config.sh` holds team-wide defaults and is committed. `local.env` holds your
personal values (project, zone, instance name) and is gitignored. An explicit
env var beats both:

```sh
RD_MACHINE_TYPE=c4-standard-16 ./create.sh
```

minio is off by default, but the devcontainer points the server at it
(`STORAGE_S3_ENDPOINT=http://minio:9000`) either way, so file uploads and
recordings fail until you turn it on. `up.sh`, `status.sh` and `tunnel.sh` say
so while it is off. To enable it, re-run `./init.sh` and answer `y` to "Run
minio?" (the other questions default to your current values), then run
`./up.sh --skip-setup`. That writes this line to `local.env`, which you can
also edit by hand:

```sh
RD_COMPOSE_FILES="docker-compose.yml docker-compose-s3.yml"
```

That also forwards 9000 (S3 API) and 9001 (console, `dembrane` / `dembrane`).

## Troubleshooting

**`./up.sh` fails on a missing `directus/.env`.** The compose file requires it.
`cp echo/directus/.env.sample echo/directus/.env`, fill it in, re-run.

**The repo did not clone.** The startup script has no git credentials, so a
private repo fails there. `./ssh.sh --vm`, authenticate, clone into the path
`create.sh` printed, then re-run `./up.sh`.

**Zed cannot connect after a restart.** The external IP is ephemeral and
changes on every boot. `./start.sh` re-runs `ssh-config.sh` for you; if you
started the VM from the console instead, run `./ssh-config.sh` by hand.

**A build gets OOM-killed.** `bootstrap-vm.sh` adds 4GB of swap, which turns
most OOMs into slowness rather than failure. If it still dies, go up a size:
`./resize.sh e2-standard-8`.

**Bootstrap seems stuck.** `./ssh.sh --vm`, then
`tail -f /var/log/dembrane-bootstrap.log`.

**`create.sh` warns that the disk is larger than the image.** Expected and
harmless. gcloud prints this whenever the boot disk exceeds the 10GB image,
and it only matters for operating systems that cannot resize their own root
partition. The Ubuntu cloud image can, and does so on first boot. Confirm with
`./ssh.sh --vm --command 'df -h /'`: the reported size should match the disk,
not 10GB.

**Running low on disk.** `./resize.sh --disk 100GB`, then reboot so the
filesystem grows into it. Reclaiming space is usually easier: `./ssh.sh --vm`
then `docker system prune -a` clears old build layers, which are what actually
accumulate over time.

## Cost

Rough us/canada list prices, running vs stopped:

| Shape | vCPU / RAM | 24/7 | 8h x 21 days | Stopped (disk only) |
|---|---|---|---|---|
| `e2-standard-4` | 4 / 16GB | ~$100/mo | ~$23/mo | ~$6/mo |
| `e2-standard-8` | 8 / 32GB | ~$200/mo | ~$46/mo | ~$6/mo |

The gap between columns one and two is `./stop.sh`. Consider a shell alias or a
calendar reminder.

## Related

- [`docs/remote-dev.md`](../../docs/remote-dev.md) covers the editor setup in
  more depth and the optional DevPod layer.
