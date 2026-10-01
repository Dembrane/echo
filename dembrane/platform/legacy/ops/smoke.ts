/**
 * Smoke tests for a freshly cut-over stack, run before the DNS switch against the Cloud Run
 * URLs and again after it against the public hostnames. Reads only, except one sign-in
 * (which writes a session row). Every check prints one line; any failure exits non-zero.
 *
 *   API_URL=https://api.dembrane.com SMOKE_EMAIL=... SMOKE_PASSWORD=... \
 *   [DASHBOARD_URL=...] [PORTAL_URL=...] [SMOKE_ORIGIN=dashboard origin, default DASHBOARD_URL] [DIRECTUS_URL=https://directus.dembrane.com] \
 *   [TARGET_URL=postgres://... read-only, picks sample rows] [SITE_TOKEN=...] \
 *   [EXPECT_ISSUER=https://api.dembrane.com/api/mcp] bun legacy/ops/smoke.ts
 *
 * What it proves, in order: the service is up and its database ready; a migrated user signs
 * in with their old password; their projects and conversations read back; a migrated audio
 * file resolves to the new bucket and downloads; a migrated avatar serves; the portal's
 * public project loads; MCP OAuth metadata names the same issuer as before; the website's
 * needs form token is accepted; the web apps serve and point at this API.
 */
import postgres from "postgres";

const API = required("API_URL").replace(/\/+$/, "");
// Better Auth refuses a sign-in whose Origin is not the configured dashboard.
const ORIGIN = (
  process.env.SMOKE_ORIGIN ??
  process.env.DASHBOARD_URL ??
  "http://localhost:5173"
).replace(/\/+$/, "");
let failures = 0;
const timings: number[] = [];

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
}

async function check(name: string, fn: () => Promise<string | undefined>): Promise<void> {
  const t0 = performance.now();
  try {
    const note = await fn();
    const ms = Math.round(performance.now() - t0);
    timings.push(ms);
    console.log(`ok    ${name} (${ms} ms)${note ? `: ${note}` : ""}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}: ${(e as Error).message}`);
  }
}

async function get(path: string, token?: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path.startsWith("http") ? path : `${API}${path}`, {
    redirect: "manual",
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      origin: ORIGIN,
      ...(init.headers ?? {}),
    },
  });
}

async function expectStatus(res: Response, ...ok: number[]): Promise<Response> {
  if (!ok.includes(res.status))
    throw new Error(`${res.url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

const db = process.env.TARGET_URL
  ? postgres(process.env.TARGET_URL, {
      max: 1,
      connection: { default_transaction_read_only: true },
      onnotice: () => {},
    })
  : null;

let token = "";
let userId = "";
let projectIds: string[] = [];

await check("health", async () => {
  const body = (await (await expectStatus(await get("/health"), 200)).json()) as {
    release?: string;
  };
  return `release ${body.release ?? "?"}`;
});
await check("ready (database reachable)", async () => {
  await expectStatus(await get("/ready"), 200);
  return undefined;
});

await check("sign in with a migrated password", async () => {
  const res = await expectStatus(
    await get("/api/auth/sign-in/email", undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: required("SMOKE_EMAIL"),
        password: required("SMOKE_PASSWORD"),
      }),
    }),
    200,
  );
  token = res.headers.get("set-auth-token") ?? ((await res.json()) as { token: string }).token;
  if (!token) throw new Error("no session token");
  return undefined;
});

await check("me", async () => {
  const me = (await (await expectStatus(await get("/api/v2/me", token), 200)).json()) as {
    id?: string;
    email?: string;
  };
  if (me.email?.toLowerCase() !== required("SMOKE_EMAIL").toLowerCase())
    throw new Error(`signed in as ${me.email}`);
  userId = me.id ?? "";
  return undefined;
});

await check("projects list", async () => {
  const body = await (await expectStatus(await get("/api/v2/bff/projects", token), 200)).json();
  const rows = (Array.isArray(body) ? body : ((body as { data?: unknown[] }).data ?? [])) as {
    id: string;
  }[];
  projectIds = rows.map((r) => r.id);
  if (!projectIds.length) throw new Error("the smoke user sees no projects");
  return `${projectIds.length} projects`;
});

if (db && projectIds.length) {
  const [conv] = await db`
    select c.id as conversation_id, ch.id as chunk_id, ch.path
    from conversation c join conversation_chunk ch on ch.conversation_id = c.id
    where c.project_id in ${db(projectIds)} and ch.path like 'http%'
    order by ch.timestamp desc nulls last limit 1`;
  if (conv) {
    await check("conversation transcript", async () => {
      await expectStatus(
        await get(`/api/conversations/${conv.conversation_id}/transcript`, token),
        200,
      );
      return undefined;
    });
    await check("migrated audio resolves to the new bucket and downloads", async () => {
      const res = await expectStatus(
        await get(
          `/api/conversations/${conv.conversation_id}/chunks/${conv.chunk_id}/content`,
          token,
        ),
        200,
        307,
      );
      const url =
        res.status === 307
          ? (res.headers.get("location") as string)
          : ((await res.json()) as string);
      if (url.includes("digitaloceanspaces")) throw new Error("still points at Spaces");
      const file = await fetch(url, { headers: { range: "bytes=0-1023" } });
      if (file.status !== 200 && file.status !== 206)
        throw new Error(`object fetch answered ${file.status}`);
      return new URL(url).host;
    });
  } else console.log("skip  audio: no chunk with a stored path in the smoke user's projects");

  const [avatar] = await db`
    select avatar from directus_users where avatar is not null limit 1`;
  if (avatar) {
    await check("migrated avatar serves from the new API", async () => {
      await expectStatus(await get(`/api/assets/${avatar.avatar}`, token), 200);
      return undefined;
    });
  }

  const [pub] = await db`
    select id from project where is_conversation_allowed = true and id in ${db(projectIds)} limit 1`.catch(
    () => [],
  );
  if (pub) {
    await check("portal: public project", async () => {
      await expectStatus(await get(`/api/participant/projects/${pub.id}`), 200);
      return undefined;
    });
  }
}

await check("MCP OAuth metadata keeps its issuer", async () => {
  const meta = (await (
    await expectStatus(await get("/api/mcp/.well-known/oauth-authorization-server"), 200)
  ).json()) as { issuer?: string };
  const want = process.env.EXPECT_ISSUER;
  if (want && meta.issuer !== want) throw new Error(`issuer ${meta.issuer}, expected ${want}`);
  return meta.issuer;
});

await check("MCP rejects a bad token", async () => {
  const res = await get("/api/mcp", "not-a-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  await expectStatus(res, 401);
  return undefined;
});

if (process.env.SITE_TOKEN) {
  await check("website needs form token accepted (422 on an empty body)", async () => {
    await expectStatus(
      await get("/api/v2/pricing-configurations/site", undefined, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-site-token": process.env.SITE_TOKEN as string,
          origin: "https://www.dembrane.com",
        },
        body: "{}",
      }),
      422,
    );
    return undefined;
  });
}

for (const [name, url] of [
  ["dashboard", process.env.DASHBOARD_URL],
  ["portal", process.env.PORTAL_URL],
] as const) {
  if (!url) continue;
  await check(`${name} serves and points at this API`, async () => {
    await expectStatus(await fetch(url), 200);
    const cfg = await (await expectStatus(await fetch(`${url}/runtime-config.js`), 200)).text();
    return cfg.includes(API)
      ? undefined
      : "runtime-config does not name API_URL (same-origin proxy?)";
  });
}

if (process.env.DIRECTUS_URL) {
  await check("directus hostname: old asset links still serve", async () => {
    if (!db) return "skipped without TARGET_URL";
    const [f] =
      await db`select id from directus_files order by uploaded_on desc nulls last limit 1`;
    if (!f) return "no files";
    await expectStatus(await fetch(`${process.env.DIRECTUS_URL}/assets/${f.id}`), 200);
    return undefined;
  });
}

await db?.end();
timings.sort((a, b) => a - b);
const p = (q: number) => timings[Math.min(timings.length - 1, Math.floor(q * timings.length))];
console.log(
  `${failures ? "FAILED" : "passed"}: ${timings.length} ok, ${failures} failed; latency p50 ${p(0.5)} ms, max ${p(1)} ms; user ${userId}`,
);
process.exit(failures ? 1 : 0);
