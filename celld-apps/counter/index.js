// A Durable Object counter plus an R2 file store. Both keep their state in the
// fleet bucket, so it survives restarts of the celld container.

export class Counter {
  constructor(state) {
    this.state = state;
  }
  async fetch() {
    const n = ((await this.state.storage.get("n")) ?? 0) + 1;
    await this.state.storage.put("n", n);
    return Response.json({ n });
  }
}

const USAGE = `GET  /count?name=NAME   increment and return the counter NAME
GET  /files            list stored files
PUT  /files/KEY        store the request body as KEY
GET  /files/KEY        read KEY back
`;

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
      const key = url.pathname.slice("/files/".length);
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

    return new Response(USAGE);
  },
};
