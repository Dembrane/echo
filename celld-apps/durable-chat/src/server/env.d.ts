// The bindings in wrangler.jsonc. Upstream generates this with `wrangler
// types`; celld has no equivalent, so keep it in step by hand.
interface Env {
  Chat: DurableObjectNamespace<import("./index").Chat>;
  ASSETS: Fetcher;
}
