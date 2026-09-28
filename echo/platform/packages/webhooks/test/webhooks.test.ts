import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger } from "@dembrane/observability";
import {
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
    for (const ip of ["8.8.8.8", "172.32.0.1", "2a00:1450::1"])
      expect(isPrivateAddress(ip)).toBe(false);
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
  const seen: { headers: Headers; body: string }[] = [];
  let status = 200;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ headers: req.headers, body: await req.text() });
        return new Response("ok", { status });
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
