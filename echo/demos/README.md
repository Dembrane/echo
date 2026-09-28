# Synthetic Popcorn demos

See [the spec](../docs/synthetic_popcorn_demos.md). The reusable workflow is the [popcorn-demo skill](../../skills/popcorn-demo/SKILL.md), using dembrane MCP as capabilities become available. The tools below are the development path until then.

Every demo is fictional and contains no real participant data. A demo about a real organisation names who dembrane is talking to, so it never goes into this public repository: keep its folder elsewhere and pass it with `--demo`. Folders placed here are ignored by git, except `example/`, a complete demo for an invented housing corporation that the tests use.

## A demo folder

- `session.json`: `slug`, `organisation`, `synthetic`, `public_sources_only`, and per language `title`, `subtitle` and `copy` (disclosure, invitation and frame). Optional `summary` per language labels each seeded conversation.
- `research.md`: the public sources and the fictional design choices. It becomes the project context.
- `corpus/NN-*.json`: the invented conversations, one per file, with `id`, `label`, `track`, `language`, `start` and `chunks`.
- `out/`: written by `run_demo.py` and read by `seed_demo.py`.

## Reading a corpus

From `echo/server` in the dev container, run the popcorn pipeline over the corpus with the same functions the tick calls, translate it into each of the session's languages, and export static previews to `.preview/`:

```sh
PYTHONPATH=.:scripts uv run python ../demos/run_demo.py --demo <folder> --portal-url en=<start link>
```

`--reanalyse` reads only the analysis views again into `out/analysis-N.json`; `--reuse` translates and exports the saved read.

## Seeding echo-next

`seed_demo.py` writes the read into a staging environment through Directus: one synthetic project per language, closed to recordings and anonymised, with the conversations and a Popcorn session in manual mode carrying the read and the synthetic marking, plus the sales portal projects the QR opens ([sales-portal.json](sales-portal.json)). Ids are deterministic, so a rerun updates that demo only. It refuses production hosts and prints the public popcorn links.

```sh
DEMO_DIRECTUS_TOKEN=<directus admin static token> python3 seed_demo.py --demo <folder> \
    --directus-url https://directus.echo-next.dembrane.com \
    --portal-base-url https://portal.echo-next.dembrane.com \
    --api-base-url https://api.echo-next.dembrane.com \
    --workspace-id <workspace> --owner-id <directus user> --dry-run
```

Drop `--dry-run` to write. The environment needs the synthetic presenter deployed and its migrations run (`echo/docs/database_migrations.md`).

## The local helper

`scripts/popcorn_demo.py` exports an authored fixture such as `example/fixture.json` with Echo's actual presenter, or seeds it into local Echo. From `echo/server`:

```sh
PYTHONPATH=. uv run python scripts/popcorn_demo.py --portal-url https://SALES-PORTAL-START-LINK
python -m http.server 5190 --bind 0.0.0.0 --directory ../demos/.preview
```

Open `http://localhost:5190/voorbeeldwonen/`. `--portal-url` is the sales portal's start link for this demo's language; the helper tags it with the demo's slug.

To populate local Echo instead, use `--seed-local --workspace-id <local-workspace> --owner-id <local-Directus-user> --portal-base-url http://YOUR-LAN-IP:5174`. The seed also writes a local sales portal project for the demo's language and points the QR at it; use the computer's LAN address so phones on the same network can reach it (`localhost` in a QR points to the phone itself). Confirm these IDs belong to a disposable local development workspace. The seed disables recording on the demo project, turns on anonymisation, creates the fictional transcripts, attaches the research and creates a paused Popcorn report without scheduling model calls. Re-running it resets the example to the fixture.

`.preview/` is the static release directory, ignored by git. `.local-session.json` beside it contains local project/report links and stays outside the served directory. Nothing has been deployed to `demo.dembrain.com` yet. All catalogue entries are labelled synthetic.
