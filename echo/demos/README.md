# Synthetic Popcorn examples

See [the spec](../docs/synthetic_popcorn_demos.md) and [deltaWonen research](deltawonen/research.md).

The reusable workflow is the [popcorn-demo skill](../../skills/popcorn-demo/SKILL.md), using dembrane MCP as capabilities become available. The commands below are a local development fixture helper, not the production MCP workflow.

The checked-in fixture is deliberately fictional. It contains no real participant data. The exporter reuses Echo's actual Popcorn presenter. It does not call a model or publish to a hosting provider. The deck's QR opens dembrane's sales portal ([sales-portal.json](sales-portal.json)), a real project that records feedback for the dembrane team.

From `echo/server`, with the development Python environment:

```sh
PYTHONPATH=. uv run python scripts/popcorn_demo.py --portal-url https://SALES-PORTAL-START-LINK
python -m http.server 5190 --bind 0.0.0.0 --directory ../demos/.preview
```

Open `http://localhost:5190/deltawonen/`. `--portal-url` is the sales portal's start link for this demo's language; the helper tags it with the demo's slug.

To populate local Echo instead, use `--seed-local --workspace-id <local-workspace> --owner-id <local-Directus-user> --portal-base-url http://YOUR-LAN-IP:5174`. The seed also writes a local sales portal project for the demo's language and points the QR at it; use the computer's LAN address so phones on the same network can reach it (`localhost` in a QR points to the phone itself). The deterministic IDs make repeat imports update only this example. Confirm these IDs belong to a disposable local development workspace. The seed uses the Directus REST client, disables recording on the demo project, turns on anonymisation, creates five fictional transcripts, attaches the research and creates a paused Popcorn report without scheduling model calls. Re-running the seed resets this example to the reviewed fixture. API and ticks worker processes must load the changed code before using the new presentation settings or reruns.

`.preview/` is the static release directory, ignored by git. `.local-session.json` beside it contains local project/report links and stays outside the served directory. To prepare a hosted release, re-export with the actual HTTPS origin, test the QR destination and deploy only `.preview/`. Nothing has been deployed to `demo.dembrain.com` yet. The server needs directory index support for `/deltawonen/`. A redirect from `/deltawonen` to `/deltawonen/` preserves the relative bundle paths.

The catalogue at `/` grows when additional fixtures are exported into the same directory. All entries are labelled synthetic.
