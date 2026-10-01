import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { TLSSocket } from "node:tls";
import { createLogger } from "@dembrane/observability";
import {
  fetchChecked,
  httpDeliver,
  isPrivateAddress,
  pythonJson,
  runDispatch,
  signature,
  type WebhooksStorage,
} from "../src";
import { enqueueConversationEvent } from "../src/service";

// Computed with the Python service: json.dumps(p, separators=(",", ":"), sort_keys=True) under HMAC-SHA256.
const payload = {
  event: "webhook.test",
  timestamp: "2026-09-27T12:00:00.000000+00:00",
  conversation: {
    id: "c",
    duration: 120,
    tags: ["énergie", "🚲"],
    summary: 'a "quoted"\nline',
    transcript: "x",
  },
  project: { id: "p", name: "Stad", language: "nl" },
  dashboardUrl: "http://localhost:5173/nl-NL/w/w/projects/p/conversations/c/overview",
  n: [1.5e-5, 0.1, 312.5],
};
const PYTHON_SIGNATURE = "sha256=3f7a00c8131af55b0b427fe9bfa42698ea38007c05aac63c43edbc20777966e5";
const PYTHON_BODY =
  '{"event": "webhook.test", "timestamp": "2026-09-27T12:00:00.000000+00:00", "conversation": {"id": "c", "duration": 120, "tags": ["\\u00e9nergie", "\\ud83d\\udeb2"], "summary": "a \\"quoted\\"\\nline", "transcript": "x"}, "project": {"id": "p", "name": "Stad", "language": "nl"}, "dashboardUrl": "http://localhost:5173/nl-NL/w/w/projects/p/conversations/c/overview", "n": [1.5e-05, 0.1, 312.5]}';

const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

describe("signing", () => {
  test("the signature matches the Python service byte for byte", () => {
    expect(signature(payload, "k3y")).toBe(PYTHON_SIGNATURE);
  });

  test("the body is what Python's requests sent", () => {
    expect(pythonJson(payload)).toBe(PYTHON_BODY);
  });

  test("floats print as Python repr", () => {
    expect(pythonJson([1e16, 1e-5, 0.0001, 2.5e-7, -3])).toBe(
      "[1e+16, 1e-05, 0.0001, 2.5e-07, -3]",
    );
  });
});

describe("private targets", () => {
  test("loopback, private, link-local and mapped addresses are private", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "2a00:1450::1", "::ffff:8.8.8.8", "2002:808:808::1"])
      expect(isPrivateAddress(ip)).toBe(false);
  });

  test("M-22: an IPv4 address carried inside IPv6 is judged as the IPv4 address it reaches", async () => {
    // The URL parser rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1] before any check runs.
    expect(new URL("http://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    for (const ip of [
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::7f00:1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::10.0.0.1",
      "2002:a00:1::1",
      "::ffff:0:7f00:1",
      "fec0::1",
      "198.18.0.1",
      "192.0.0.1",
      "not-an-ip",
    ])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    const deliver = httpDeliver({ allowPrivate: false });
    for (const url of [
      "http://[::ffff:127.0.0.1]:9/x",
      "http://[::ffff:169.254.169.254]/",
      "http://[64:ff9b::a9fe:a9fe]/",
    ])
      await expect(deliver({ id: "w", name: "n", url, secret: null }, {})).rejects.toThrow(
        "private or internal address",
      );
  });

  test("delivery refuses internal targets unless allowed", async () => {
    const deliver = httpDeliver({ allowPrivate: false });
    await expect(
      deliver({ id: "w", name: "n", url: "http://127.0.0.1:9/x", secret: null }, {}),
    ).rejects.toThrow("private or internal address");
  });
});

describe("delivery", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { url: string; headers: Headers; body: string }[] = [];
  let status = 200;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push({ url: req.url, headers: req.headers, body: await req.text() });
        return new Response("ok", {
          status,
          headers: status === 302 ? { location: "http://127.0.0.1:9/elsewhere" } : {},
        });
      },
    });
  });
  afterAll(() => server.stop(true));

  test("posts the Python body with event and signature headers", async () => {
    const deliver = httpDeliver({ allowPrivate: true });
    const res = await deliver(
      { id: "w", name: "n", url: `http://127.0.0.1:${server.port}/in`, secret: "k3y" },
      payload,
    );
    expect(res.status).toBe(200);
    const got = seen.at(-1);
    expect(got?.body).toBe(PYTHON_BODY);
    expect(got?.headers.get("x-webhook-event")).toBe("webhook.test");
    expect(got?.headers.get("user-agent")).toBe("Dembrane-Webhook/1.0");
    expect(got?.headers.get("x-webhook-signature")).toBe(PYTHON_SIGNATURE);
    // A receiver verifies by signing the sorted compact form of what it parsed.
    const recomputed = `sha256=${createHmac("sha256", "k3y")
      .update(pythonJson(JSON.parse(got?.body ?? "{}"), { sortKeys: true, compact: true }))
      .digest("hex")}`;
    expect(recomputed).toBe(PYTHON_SIGNATURE);
  });

  test("a hostname is resolved once and the request goes to that address under its own name", async () => {
    const asked: string[] = [];
    const deliver = httpDeliver({
      allowPrivate: true,
      resolve: async (host) => {
        asked.push(host);
        return ["127.0.0.1"];
      },
    });
    status = 200;
    const res = await deliver(
      { id: "w", name: "n", url: `http://hooks.example:${server.port}/in?a=1`, secret: "k3y" },
      payload,
    );
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(asked).toEqual(["hooks.example"]);
    const got = seen.at(-1);
    expect(got?.url).toBe(`http://hooks.example:${server.port}/in?a=1`);
    expect(got?.headers.get("host")).toBe(`hooks.example:${server.port}`);
    expect(got?.body).toBe(PYTHON_BODY);
    expect(got?.headers.get("x-webhook-signature")).toBe(PYTHON_SIGNATURE);
  });

  test("an address that does not answer gives way to the next one, and the request arrives once", async () => {
    const deliver = httpDeliver({ allowPrivate: true, resolve: async () => ["::1", "127.0.0.1"] });
    const before = seen.length;
    const res = await deliver(
      { id: "w", name: "n", url: `http://hooks.example:${server.port}/in`, secret: null },
      payload,
    );
    expect(res.status).toBe(200);
    expect(seen.length).toBe(before + 1);
  });

  test("a hostname with one internal address among its answers is refused and nothing is sent", async () => {
    let asked = 0;
    const deliver = httpDeliver({
      allowPrivate: false,
      resolve: async () => {
        asked++;
        return ["8.8.8.8", "127.0.0.1"];
      },
    });
    const before = seen.length;
    await expect(
      deliver(
        { id: "w", name: "n", url: `http://hooks.example:${server.port}/in`, secret: null },
        payload,
      ),
    ).rejects.toThrow("private or internal address");
    expect(asked).toBe(1);
    expect(seen.length).toBe(before);
  });

  test("a redirect is handed back, not followed", async () => {
    status = 302;
    const res = await fetchChecked(
      `http://hooks.example:${server.port}/in`,
      {},
      { allowPrivate: true, resolve: async () => ["127.0.0.1"] },
    );
    status = 200;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:9/elsewhere");
  });

  test("dispatch: 2xx done, 4xx dropped, 5xx retried, unpublished skipped", async () => {
    const hook = {
      id: "w",
      name: "n",
      url: `http://127.0.0.1:${server.port}/in`,
      secret: null,
      status: "published",
    };
    const store = { get: async () => hook } as unknown as WebhooksStorage;
    const deps = { store, deliver: httpDeliver({ allowPrivate: true }), logger: quiet };
    status = 204;
    await runDispatch(deps, { webhookId: "w", payload: { event: "x" } });
    status = 410;
    await runDispatch(deps, { webhookId: "w", payload: { event: "x" } });
    status = 503;
    await expect(runDispatch(deps, { webhookId: "w", payload: { event: "x" } })).rejects.toThrow(
      "Webhook returned status 503",
    );
    const before = seen.length;
    hook.status = "draft";
    await runDispatch(deps, { webhookId: "w", payload: { event: "x" } });
    expect(seen.length).toBe(before);
  });
});

// The certificate is made on the spot, so the test runs where openssl is installed.
describe.skipIf(!Bun.which("openssl"))("delivery over TLS", () => {
  let dir = "";
  const names: unknown[] = [];
  let server: ReturnType<typeof createServer>;
  let port = 0;
  let ca = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "webhooks-tls-"));
    const run = (...args: string[]) => {
      const done = Bun.spawnSync(["openssl", ...args], { cwd: dir });
      if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    };
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
    run("req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=test ca");
    run("req", ...ec, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=hooks.example");
    writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:hooks.example\n");
    run(
      ...["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key"],
      ...["-CAcreateserial", "-out", "leaf.pem", "-extfile", "ext.cnf"],
    );
    ca = readFileSync(join(dir, "ca.pem"), "utf8");
    server = createServer(
      { key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.pem")) },
      (req, res) => {
        names.push((req.socket as TLSSocket).servername);
        res.end(req.headers.host);
      },
    );
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const opts = { allowPrivate: true, resolve: async () => ["127.0.0.1"] };

  test("the hostname is the TLS server name and the name the certificate is checked for", async () => {
    const res = await fetchChecked(`https://hooks.example:${port}/in`, { tls: { ca } }, opts);
    expect(await res.text()).toBe(`hooks.example:${port}`);
    expect(names.at(-1)).toBe("hooks.example");
  });

  test("a certificate for another name fails the request", async () => {
    await expect(
      fetchChecked(`https://other.example:${port}/in`, { tls: { ca } }, opts),
    ).rejects.toThrow("ERR_TLS_CERT_ALTNAME_INVALID");
  });
});

describe("event fan-out", () => {
  const project = { id: "p", name: "Stad", language: "nl", workspace_id: "ws" };
  const store = {
    publishedForProject: async () => [
      { id: "a", events: '["conversation.transcribed"]' },
      { id: "b", events: '["conversation.started"]' },
    ],
    conversation: async () => ({
      id: "c",
      created_at: "2026-09-01T09:20:00.000Z",
      updated_at: "2026-09-01T09:30:00.000Z",
      participant_name: "Resident",
      duration: 312.5,
      source: "PORTAL_AUDIO",
      is_finished: true,
      is_all_chunks_transcribed: true,
      summary: "s",
      tags: [{ text: "energy" }, { text: null }],
    }),
    project: async () => project,
    transcript: async () => "one\ntwo",
    emails: async () => "a@example.com",
  } as unknown as WebhooksStorage;

  test("one job per subscribed webhook, with the transcript for transcribed events", async () => {
    const sent: { name: string; payload: Record<string, unknown> }[] = [];
    const jobs = {
      enqueue: async (def: { name: string }, p: unknown) => {
        sent.push({ name: def.name, payload: p as Record<string, unknown> });
        return "job";
      },
    };
    const n = await enqueueConversationEvent(
      {
        store,
        jobs,
        now: () => new Date("2026-09-27T12:00:00Z"),
        enabled: true,
        dashboardUrl: "https://dashboard.dembrane.com/",
      },
      "p",
      "c",
      "conversation.transcribed",
    );
    expect(n).toBe(1);
    expect(sent[0]?.name).toBe("webhooks.dispatch");
    expect(sent[0]?.payload).toEqual({
      webhookId: "a",
      payload: {
        event: "conversation.transcribed",
        timestamp: "2026-09-27T12:00:00.000000+00:00",
        conversation: {
          id: "c",
          created_at: "2026-09-01T09:20:00.000Z",
          updated_at: "2026-09-01T09:30:00.000Z",
          participant_name: "Resident",
          duration: 312.5,
          source: "PORTAL_AUDIO",
          is_finished: true,
          is_all_chunks_transcribed: true,
          tags: ["energy"],
          emails_csv: "a@example.com",
          transcript: "one\ntwo",
        },
        project: { id: "p", name: "Stad", language: "nl" },
        dashboardUrl:
          "https://dashboard.dembrane.com/nl-NL/w/ws/projects/p/conversations/c/overview",
      },
    });
  });

  test("nothing is queued while webhooks are switched off", async () => {
    const jobs = { enqueue: async () => "job" };
    const n = await enqueueConversationEvent(
      { store, jobs, now: () => new Date(), enabled: false, dashboardUrl: "x" },
      "p",
      "c",
      "conversation.transcribed",
    );
    expect(n).toBe(0);
  });
});
