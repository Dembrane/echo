import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createLogger } from "@dembrane/observability";
import {
  deliverSamMessage,
  enqueueSamMessage,
  MemorySamQueue,
  postSamEnvelope,
  type Quarantined,
  quarantineSamMessage,
  runDeliverSamMessage,
  runQuarantineSamMessage,
  SAM_INBOX_MAX_BODY,
  type SamEnvelope,
  SamInboxQuarantined,
  SamInboxRetry,
  samEnvelope,
  samInboxForwarder,
  samInboxSignature,
  samOutcome,
  sendSamMessage,
} from "../src";
import vectors from "./sam-inbox-vectors.json";

const lines: Record<string, unknown>[] = [];
const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "info" },
  new Writable({
    write(c, _e, cb) {
      lines.push(JSON.parse(c.toString()));
      cb();
    },
  }),
);

// The same file sam's verifier reads, so both sides sign the same bytes the same way.
test.each(vectors)("signature vector for $id", (v) => {
  expect(
    samInboxSignature({
      secret: v.secret,
      from: v.from,
      timestamp: v.timestamp,
      id: v.id,
      body: v.body,
    }),
  ).toBe(v.expected);
  // The raw bytes sign the same as the string they decode to.
  expect(
    samInboxSignature({
      secret: v.secret,
      from: v.from,
      timestamp: v.timestamp,
      id: v.id,
      body: new TextEncoder().encode(v.body),
    }),
  ).toBe(v.expected);
});

test("the envelope is the body serialised once, code first, Unicode left as UTF-8", () => {
  const e = samEnvelope({
    code: "echo_support_chat_escalated_v1",
    json: { m: "café 🎉" },
    id: "r1",
  });
  expect(e).toEqual({
    code: "echo_support_chat_escalated_v1",
    id: "r1",
    body: '{"code":"echo_support_chat_escalated_v1","json":{"m":"café 🎉"}}',
  });
});

test("an unversioned code, a multi-line id or an oversized body is refused before queueing", () => {
  expect(() => samEnvelope({ code: "support_request", json: {}, id: "a" })).toThrow();
  expect(() => samEnvelope({ code: "Support_v1", json: {}, id: "a" })).toThrow();
  expect(() => samEnvelope({ code: "x_v1", json: {}, id: "a\nb" })).toThrow();
  expect(() => samEnvelope({ code: "x_v1", json: {}, id: "" })).toThrow();
  const big = "x".repeat(SAM_INBOX_MAX_BODY);
  expect(() => samEnvelope({ code: "x_v1", json: { big }, id: "a" })).toThrow();
});

test("2xx is done; 408, 429 and 5xx retry; every other answer is permanent", () => {
  for (const s of [200, 201, 204]) expect(samOutcome(s)).toBe("delivered");
  for (const s of [408, 429, 500, 502, 503, 504]) expect(samOutcome(s)).toBe("retry");
  for (const s of [301, 302, 400, 401, 403, 404, 409, 413, 422])
    expect(samOutcome(s)).toBe("permanent");
});

describe("the sender against a receiver", () => {
  const seen: { headers: Headers; raw: Uint8Array }[] = [];
  const answer = 200;
  let server: ReturnType<typeof Bun.serve>;
  let url = "";
  const target = () => ({ url, secret: "z".repeat(40), from: "api.staging.dembrane.com" });

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push({ headers: req.headers, raw: new Uint8Array(await req.arrayBuffer()) });
        if (new URL(req.url).pathname === "/moved")
          return new Response(null, { status: 302, headers: { location: `${url}` } });
        return new Response("ok", { status: answer });
      },
    });
    url = `http://127.0.0.1:${server.port}/inbox`;
  });
  afterAll(() => server.stop(true));

  test("sends the four headers and signs exactly the bytes it sends", async () => {
    seen.length = 0;
    const res = await sendSamMessage(
      target(),
      {
        code: "echo_account_ticket_opened_v1",
        json: { subject: "Kwartaalfacturen? ’s-Hertogenbosch 🎉" },
        id: "ev-1",
      },
      { allowPrivate: true, now: () => new Date("2026-10-02T10:00:00.900Z") },
    );
    expect(res.status).toBe(200);
    const [req] = seen;
    if (!req) throw new Error("no request");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("x-webhook-from")).toBe("api.staging.dembrane.com");
    expect(req.headers.get("x-webhook-timestamp")).toBe("1790935200");
    expect(req.headers.get("x-webhook-id")).toBe("ev-1");
    expect(req.headers.get("x-webhook-signature")).toBe(
      samInboxSignature({
        secret: "z".repeat(40),
        from: "api.staging.dembrane.com",
        timestamp: "1790935200",
        id: "ev-1",
        body: req.raw,
      }),
    );
    expect(JSON.parse(new TextDecoder().decode(req.raw))).toEqual({
      code: "echo_account_ticket_opened_v1",
      json: { subject: "Kwartaalfacturen? ’s-Hertogenbosch 🎉" },
    });
  });

  test("a retry sends the same body and id with a fresh timestamp and signature", async () => {
    seen.length = 0;
    const envelope = samEnvelope({
      code: "echo_billing_overage_v1",
      json: { n: 1 },
      id: "ep:opened",
    });
    await postSamEnvelope(target(), envelope, {
      allowPrivate: true,
      now: () => new Date(1_790_000_000_000),
    });
    await postSamEnvelope(target(), envelope, {
      allowPrivate: true,
      now: () => new Date(1_790_000_030_000),
    });
    const [a, b] = seen;
    if (!a || !b) throw new Error("expected two requests");
    expect(b.raw).toEqual(a.raw);
    expect(b.headers.get("x-webhook-id")).toBe(a.headers.get("x-webhook-id") as string);
    expect(a.headers.get("x-webhook-timestamp")).toBe("1790000000");
    expect(b.headers.get("x-webhook-timestamp")).toBe("1790000030");
    expect(b.headers.get("x-webhook-signature")).not.toBe(
      a.headers.get("x-webhook-signature") as string,
    );
  });

  test("a redirect is not followed and counts as permanent", async () => {
    seen.length = 0;
    const res = await postSamEnvelope(
      { ...target(), url: url.replace("/inbox", "/moved") },
      samEnvelope({ code: "x_v1", json: {}, id: "r" }),
      { allowPrivate: true },
    );
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
    expect(samOutcome(res.status)).toBe("permanent");
  });

  test("a private address is refused unless allowed", async () => {
    await expect(
      postSamEnvelope(target(), samEnvelope({ code: "x_v1", json: {}, id: "r" }), {
        allowPrivate: false,
      }),
    ).rejects.toThrow("private");
  });
});

describe("the delivery job", () => {
  const envelope: SamEnvelope = samEnvelope({
    code: "echo_account_document_signed_v1",
    json: { id: "ev" },
    id: "ev",
  });
  const posting = (status: number | Error) => {
    const sent: SamEnvelope[] = [];
    const quarantined: Quarantined[] = [];
    return {
      sent,
      quarantined,
      post: async (e: SamEnvelope) => {
        sent.push(e);
        if (status instanceof Error) throw status;
        return { status, text: "nope" };
      },
      quarantine: async (q: Quarantined) => {
        quarantined.push(q);
      },
    };
  };

  test("a 2xx completes", async () => {
    const p = posting(200);
    await runDeliverSamMessage({ ...p, logger }, envelope);
    expect(p.sent).toEqual([envelope]);
    expect(p.quarantined).toEqual([]);
  });

  test("busy, down or unreachable throws so the queue retries", async () => {
    for (const s of [408, 429, 500, 503]) {
      const p = posting(s);
      await expect(runDeliverSamMessage({ ...p, logger }, envelope)).rejects.toBeInstanceOf(
        SamInboxRetry,
      );
      expect(p.quarantined).toEqual([]);
    }
    await expect(
      runDeliverSamMessage({ ...posting(new Error("ECONNRESET")), logger }, envelope),
    ).rejects.toThrow("ECONNRESET");
  });

  test("a refusal is quarantined with its envelope and the answer, not retried", async () => {
    lines.length = 0;
    for (const status of [400, 401, 403, 409, 413, 422]) {
      const p = posting(status);
      await runDeliverSamMessage({ ...p, logger }, envelope);
      expect(p.quarantined).toEqual([
        { ...envelope, status, reason: `sam answered ${status}: nope` },
      ]);
    }
    expect(lines.filter((l) => l.signal === "sam_inbox.refused")).toHaveLength(6);
  });

  test("a quarantine run fails on purpose, so it stays failed and visible", async () => {
    const q = quarantineSamMessage.schema.parse({
      ...envelope,
      reason: "sam answered 409",
      status: 409,
    });
    await expect(runQuarantineSamMessage({ logger }, q)).rejects.toBeInstanceOf(
      SamInboxQuarantined,
    );
    expect(quarantineSamMessage.retryLimit).toBe(0);
  });

  test("an unconfigured inbox fails the run instead of dropping it", async () => {
    await expect(
      runDeliverSamMessage({ ...posting(200), post: null, logger }, envelope),
    ).rejects.toBeInstanceOf(SamInboxRetry);
  });

  test("enqueueing stores the serialised envelope once per (code, id), in the producer's transaction", async () => {
    const q = new MemorySamQueue();
    const m = { code: "echo_support_mcp_tool_requested_v1", json: { a: 1 }, id: "i1" };
    await enqueueSamMessage(q, m, { tx: "the-tx" });
    // The same event again with a changed body keeps the first bytes.
    await enqueueSamMessage(q, { ...m, json: { a: 2 } });
    expect(q.jobs).toEqual([
      {
        name: deliverSamMessage.name,
        payload: {
          code: "echo_support_mcp_tool_requested_v1",
          id: "i1",
          body: '{"code":"echo_support_mcp_tool_requested_v1","json":{"a":1}}',
        },
        tx: "the-tx",
        workflowId: "sam-inbox:echo_support_mcp_tool_requested_v1:i1",
      },
    ]);
  });

  test("a message sam would refuse for its size is quarantined, not queued for delivery", async () => {
    const q = new MemorySamQueue();
    await enqueueSamMessage(q, {
      code: "echo_billing_overage_v1",
      json: { big: "x".repeat(SAM_INBOX_MAX_BODY) },
      id: "ep:opened",
    });
    expect(q.of(deliverSamMessage.name)).toEqual([]);
    expect(q.of(quarantineSamMessage.name)).toEqual([
      expect.objectContaining({ code: "echo_billing_overage_v1", id: "ep:opened", status: null }),
    ]);
  });
});

describe("the outbox forwarder", () => {
  const toMessage = (p: Record<string, unknown>) =>
    p.kind === "known" ? { code: "known_v1", json: p, id: String(p.id) } : null;

  test("queues a named payload and answers 202, so the outbox stamps the row", async () => {
    const q = new MemorySamQueue();
    const fwd = samInboxForwarder(q, toMessage);
    expect((await fwd.post({ kind: "known", id: "k1" })).status).toBe(202);
    expect(q.of<SamEnvelope>(deliverSamMessage.name).map((e) => e.id)).toEqual(["k1"]);
  });

  test("a payload it cannot name is quarantined and still answered 202, so it leaves the batch", async () => {
    const q = new MemorySamQueue();
    const fwd = samInboxForwarder(q, toMessage);
    expect((await fwd.post({ kind: "other", id: "k2" })).status).toBe(202);
    expect(q.of(deliverSamMessage.name)).toEqual([]);
    expect(q.of(quarantineSamMessage.name)).toEqual([
      expect.objectContaining({
        code: null,
        id: "k2",
        reason: "no sam inbox code for this payload",
      }),
    ]);
  });

  test("a rebuilt payload under the same id resends the first envelope", async () => {
    const q = new MemorySamQueue();
    const fwd = samInboxForwarder(q, toMessage);
    await fwd.post({ kind: "known", id: "ep", peak: 5 });
    await fwd.post({ kind: "known", id: "ep", peak: 7 });
    const sent = q.of<SamEnvelope>(deliverSamMessage.name);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "").json.peak).toBe(5);
  });
});
