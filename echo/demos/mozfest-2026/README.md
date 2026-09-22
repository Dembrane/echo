# MozFest 2026: a synthetic Popcorn demo

dembrane imagined as listening infrastructure across MozFest 2026 (Recinte Fabra i Coats, Barcelona, October 28 to 30, theme Wilding). Everything here is invented and labelled synthetic. See [research.md](research.md) for the public sources and the design choices.

- `corpus/`: eight invented harvest conversations, one per track plus an open booth by the café (five in English, Wilding Knowledge in Spanish, Wilding With Nature in Catalan), and the brief they were written from.
- `session.json`: title, subtitle, disclosure, invitation and frame, in English and Spanish.
- `out/read.json`: the popcorn pipeline's read of the corpus (first pass, second pass, tensions pipeline, stakeholders), made by `run_local.py` with the same functions the tick calls. Unlike the deltaWonen fixture, nothing in it was written by hand. The stakeholder map comes from a second analysis read, because the first one ran out of answer tokens.
- `out/state-{en,es}.json`, `out/settings-{en,es}.json`: the session per language, translated into that language, with each phrase also popping in the other one.

## Seeding an environment

`seed.py` writes the demo into a staging environment through Directus, as the demo tooling does locally: two synthetic projects (EN and ES) with the eight conversations, closed to recordings and anonymised, each with a Popcorn session in manual mode carrying the read above and the synthetic marking, plus the sales portal projects the QR opens (English words from `../sales-portal.json`, Spanish ones in the script). Ids are deterministic, so a rerun updates this demo only. It refuses production hosts.

```sh
MOZFEST_DIRECTUS_TOKEN=<directus admin static token> python3 seed.py \
    --directus-url https://directus.echo-next.dembrane.com \
    --portal-base-url https://portal.echo-next.dembrane.com \
    --api-base-url https://api.echo-next.dembrane.com \
    --workspace-id <workspace> --owner-id <directus user> --dry-run
```

Drop `--dry-run` to write. It prints the two public popcorn links. The environment needs this branch deployed and its migrations run (`echo/docs/database_migrations.md`). A Rerun on that environment reads the same conversations again with its own tick.

## Reading again locally

From `echo/server` in the dev container: `PYTHONPATH=.:scripts uv run python ../demos/mozfest-2026/run_local.py --portal-url en=<start link> --portal-url es=<start link>` reads everything again; `--reanalyse` reads only the analysis views into `out/analysis-N.json`; `--reuse` translates the saved read and exports static previews to `../.preview/`.
