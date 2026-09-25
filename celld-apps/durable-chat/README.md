# durable-chat

Cloudflare's [durable-chat-template](https://github.com/cloudflare/durable-chat-template)
(copied at `8237ee7`) running on celld: a React chat whose rooms are Durable
Objects (via [partyserver](https://github.com/cloudflare/partykit/tree/main/packages/partyserver)),
with messages kept in each room's SQLite storage.

Changes from upstream, for celld:

- `wrangler.jsonc` drops the keys `celld deploy` rejects (`build`,
  `observability`, `upload_source_maps`); `pnpm run build` does what `build` did.
- `src/server/env.d.ts` replaces the `wrangler types` output, with the runtime
  types from `@cloudflare/workers-types`.
- pnpm instead of npm, and no wrangler.

Set up celld as in [../counter/README.md](../counter/README.md), then, with
`./tunnel.sh` open:

```sh
pnpm install
pnpm run deploy    # builds the client, then deploys
```

Open http://localhost:8787 and it redirects to a fresh room; share that URL
with a second tab to chat between them.

`pnpm dev` runs it locally instead (http://localhost:9876). It rebuilds the
Worker on change but not the client; rerun `pnpm run build` for that.
`pnpm run check` typechecks both.
