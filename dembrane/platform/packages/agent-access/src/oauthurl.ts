/**
 * URL handling the way the Python authorisation server did it (pydantic AnyUrl on the Rust
 * url crate, urllib for redirects), so redirect URIs registered before cutover still match
 * and the redirects clients receive are byte-identical.
 */

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** pydantic's AnyUrl: the normalised URL, or the reason it is not one. */
export function parseUrl(
  value: string,
  opts: { http?: boolean; preserveEmptyPath?: boolean } = {},
): { href: string } | { error: string } {
  if (!SCHEME.test(value))
    return { error: "Input should be a valid URL, relative URL without a base" };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { error: "Input should be a valid URL, empty host" };
  }
  if (opts.http && u.protocol !== "http:" && u.protocol !== "https:")
    return { error: "URL scheme should be 'http' or 'https'" };
  let href = u.href;
  // Models configured with url_preserve_empty_path keep "https://host" without the slash
  // WHATWG adds; the authorisation request model is not, so its URLs gain it.
  if (
    opts.preserveEmptyPath &&
    u.pathname === "/" &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*\//.test(value)
  )
    href = href.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)\//, "$1");
  return { href };
}

/** Python's urllib.parse.quote_plus with safe="": what urlencode writes. */
export function quotePlus(v: string): string {
  return encodeURIComponent(v)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/**
 * The MCP SDK's construct_redirect_uri: the base's own query parameters (blank ones
 * dropped, as parse_qs drops them), then the given ones that are not null.
 */
export function constructRedirectUri(
  base: string,
  params: Record<string, string | null | undefined>,
) {
  const hashAt = base.indexOf("#");
  const fragment = hashAt >= 0 ? base.slice(hashAt) : "";
  const noFragment = hashAt >= 0 ? base.slice(0, hashAt) : base;
  const queryAt = noFragment.indexOf("?");
  const head = queryAt >= 0 ? noFragment.slice(0, queryAt) : noFragment;
  const pairs: [string, string][] = [];
  if (queryAt >= 0)
    for (const part of noFragment.slice(queryAt + 1).split(/[&;]/)) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const k = decodeURIComponent((eq >= 0 ? part.slice(0, eq) : part).replace(/\+/g, " "));
      const v = decodeURIComponent((eq >= 0 ? part.slice(eq + 1) : "").replace(/\+/g, " "));
      if (v) pairs.push([k, v]);
    }
  for (const [k, v] of Object.entries(params))
    if (v !== null && v !== undefined) pairs.push([k, v]);
  const query = pairs.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join("&");
  return `${head}${query ? `?${query}` : ""}${fragment}`;
}

/** The host and port part of a URL, as urlparse(...).netloc read it. */
export function netloc(url: string): string {
  const m = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/);
  return m ? (m[1] as string) : "";
}
