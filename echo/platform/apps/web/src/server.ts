import { join, normalize } from "node:path";

export interface WebOptions {
  readonly distDir: string;
  readonly headers: Record<string, string>;
  /** Written into /runtime-config.js, read by the frontend before any module loads. */
  readonly runtime: Record<string, unknown>;
  /** Forward /api here; unset serves the frontend only. */
  readonly apiOrigin?: string | undefined;
  readonly release: string;
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
];

/**
 * Serves the built frontend. Unknown paths get index.html so client-side routes load on
 * refresh. /api is forwarded to the API on the same origin, so sign-in cookies stay
 * first-party on any host and the browser never makes a cross-origin call.
 */
export function createHandler(opts: WebOptions) {
  const indexPath = join(opts.distDir, "index.html");
  const runtimeJs = `window.__ECHO_RUNTIME__ = ${JSON.stringify(opts.runtime)};\n`;

  const withHeaders = (res: Response, extra: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries({ ...opts.headers, ...extra })) res.headers.set(k, v);
    return res;
  };

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (path === "/health") return Response.json({ status: "ok", release: opts.release });
    if (path === "/runtime-config.js") {
      return withHeaders(
        new Response(runtimeJs, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
        {
          "Cache-Control": "no-store",
        },
      );
    }
    if (opts.apiOrigin && (path === "/api" || path.startsWith("/api/")))
      return proxy(req, url, opts.apiOrigin);

    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    if (safe !== "/" && !safe.includes("\0")) {
      const file = Bun.file(join(opts.distDir, safe));
      if (await file.exists()) {
        const immutable = safe.startsWith("/assets/");
        return withHeaders(new Response(file), {
          "Cache-Control": immutable
            ? "public, max-age=31536000, immutable"
            : safe === "/version.json"
              ? "no-store"
              : "public, max-age=300",
        });
      }
      if (safe.startsWith("/assets/"))
        return withHeaders(new Response("Not found", { status: 404 }));
    }
    return withHeaders(
      new Response(Bun.file(indexPath), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      {
        "Cache-Control": "no-cache",
      },
    );
  };
}

async function proxy(req: Request, url: URL, origin: string): Promise<Response> {
  const target = new URL(url.pathname + url.search, origin);
  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.delete("host");
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? null : req.body,
    redirect: "manual",
  });
  const out = new Headers(upstream.headers);
  for (const h of HOP_BY_HOP) out.delete(h);
  out.delete("content-encoding");
  out.delete("content-length");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}
