// A Durable Object counter plus an R2 file store. Both keep their state in the
// fleet bucket, so it survives restarts of the celld container. GET / is
// served from public/ before this Worker runs.

export class Counter {
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    let n = (await this.state.storage.get("n")) ?? 0;
    if (request.method === "POST") {
      n++;
      await this.state.storage.put("n", n);
    }
    return Response.json({ n });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/count") {
      const name = url.searchParams.get("name") ?? "default";
      return env.COUNTER.get(env.COUNTER.idFromName(name)).fetch(request);
    }

    if (url.pathname === "/files") {
      const { objects } = await env.FILES.list();
      return Response.json(objects.map(({ key, size }) => ({ key, size })));
    }

    if (url.pathname.startsWith("/files/")) {
      const key = decodeURIComponent(url.pathname.slice("/files/".length));
      if (request.method === "PUT") {
        await env.FILES.put(key, request.body, {
          httpMetadata: {
            contentType: request.headers.get("content-type") ??
              "application/octet-stream",
          },
        });
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        const object = await env.FILES.get(key);
        if (object === null) return new Response("Not found.\n", { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        return new Response(object.body, { headers });
      }
      return new Response("Method not allowed.\n", { status: 405 });
    }

    return new Response("Not found.\n", { status: 404 });
  },
};
