import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, MemoryAccessStore, MemoryStaffAudit } from "@dembrane/access";
import type { Signed } from "@dembrane/http";
import { createLogger } from "@dembrane/observability";
import {
  runDispatch,
  SAM_INBOX_WEBHOOK_CODES,
  type SamEnvelope,
  SamInboxRetry,
  type WebhooksStorage,
} from "../src";
import { setWebhookTarget, testWebhook, type WebhookDeps } from "../src/service";
import type { WebhookRow } from "../src/storage";

const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

const PROJECT = "a0000000-0000-4000-8000-000000000001";
const HOOK = "b0000000-0000-4000-8000-000000000001";

const row = (extra: Partial<WebhookRow> = {}): WebhookRow =>
  ({
    id: HOOK,
    project_id: PROJECT,
    name: "Sales calls",
    url: "https://sales-proxy.example/webhook",
    secret: "s",
    events: '["conversation.transcribed"]',
    status: "published",
    deleted_at: null,
    date_created: null,
    date_updated: null,
    user_created: null,
    user_updated: null,
    ...extra,
  }) as WebhookRow;

const who = (isStaff: boolean): Signed =>
  ({ directusUserId: "d1", appUserId: "a1", isStaff, email: "x@dembrane.com" }) as Signed;

function deps(samInbox = true) {
  let current = row();
  const updates: Partial<WebhookRow>[] = [];
  const audit = new MemoryStaffAudit();
  const store = {
    inProject: async () => current,
    update: async (_id: string, values: Partial<WebhookRow>) => {
      updates.push(values);
      current = { ...current, ...values };
      return current;
    },
    project: async () => ({ id: PROJECT, name: "Client Meetings (Sales)" }),
  } as unknown as WebhooksStorage;
  const d: WebhookDeps = {
    store,
    access: new Access(new MemoryAccessStore()),
    jobs: { enqueue: async () => null },
    deliver: async () => ({ status: 200, text: "" }),
    now: () => new Date("2026-10-02T09:00:00Z"),
    enabled: true,
    allowPrivateTargets: true,
    dashboardUrl: "https://dash.test",
    staffAudit: audit,
    samInbox,
  };
  return { d, audit, updates, current: () => current };
}

describe("aiming a webhook at sam's inbox", () => {
  test("only staff may change the target, and every change is audited", async () => {
    const { d, audit, updates } = deps();
    await expect(
      setWebhookTarget(d, who(false), PROJECT, HOOK, {
        target: "sam_inbox",
        code: "echo_sales_call_transcript_v1",
        url: null,
      }),
    ).rejects.toMatchObject({ code: "access.staff_only" });
    expect(updates).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);

    const res = await setWebhookTarget(d, who(true), PROJECT, HOOK, {
      target: "sam_inbox",
      code: "echo_sales_call_transcript_v1",
      url: null,
    });
    expect(res).toMatchObject({
      target: "sam_inbox",
      inbox_code: "echo_sales_call_transcript_v1",
      url: "sam-inbox:echo_sales_call_transcript_v1",
    });
    expect(audit.entries).toEqual([
      expect.objectContaining({
        permission: "staff:webhooks",
        action: "project_webhook.target.update",
        targetId: HOOK,
      }),
    ]);
  });

  test("a staff key without staff:webhooks is refused", async () => {
    const { d } = deps();
    const keyHolder = { ...who(true), staffPolicies: ["staff:accounts"] } as unknown as Signed;
    await expect(
      setWebhookTarget(d, keyHolder, PROJECT, HOOK, {
        target: "sam_inbox",
        code: "echo_sales_call_transcript_v1",
        url: null,
      }),
    ).rejects.toMatchObject({ code: "access.staff_only" });
  });

  test("only the allowed codes, and only with the inbox configured", async () => {
    expect([...SAM_INBOX_WEBHOOK_CODES]).toEqual(["echo_sales_call_transcript_v1"]);
    const { d } = deps();
    for (const body of [
      { target: "sam_inbox", code: null, url: null },
      { target: "sam_inbox", code: "echo_support_manual_escalated_v1", url: null },
      { target: "sam_inbox", code: "echo_sales_call_transcript_v1", url: "https://x.example" },
      { target: "url", code: "echo_sales_call_transcript_v1", url: "https://x.example" },
      { target: "url", code: null, url: null },
      { target: "slack", code: null, url: null },
    ])
      await expect(setWebhookTarget(d, who(true), PROJECT, HOOK, body)).rejects.toMatchObject({
        code: "webhook.invalid_target",
      });
    await expect(
      setWebhookTarget(deps(false).d, who(true), PROJECT, HOOK, {
        target: "sam_inbox",
        code: "echo_sales_call_transcript_v1",
        url: null,
      }),
    ).rejects.toMatchObject({ code: "webhook.sam_inbox_unavailable" });
  });

  test("pointing it back at a URL makes it an ordinary webhook again", async () => {
    const { d, current } = deps();
    await setWebhookTarget(d, who(true), PROJECT, HOOK, {
      target: "sam_inbox",
      code: "echo_sales_call_transcript_v1",
      url: null,
    });
    const res = await setWebhookTarget(d, who(true), PROJECT, HOOK, {
      target: "url",
      code: null,
      url: "https://sales-proxy.example/webhook",
    });
    expect(res).toMatchObject({ target: "url", inbox_code: null });
    expect(current().url).toBe("https://sales-proxy.example/webhook");
    // Back on a URL, the private-address rule applies as on the customer route.
    await expect(
      setWebhookTarget({ ...d, allowPrivateTargets: false }, who(true), PROJECT, HOOK, {
        target: "url",
        code: null,
        url: "http://127.0.0.1/hook",
      }),
    ).rejects.toMatchObject({ code: "webhook.target_not_allowed" });
  });

  test("the test button refuses a webhook aimed at the inbox", async () => {
    const { d } = deps();
    await setWebhookTarget(d, who(true), PROJECT, HOOK, {
      target: "sam_inbox",
      code: "echo_sales_call_transcript_v1",
      url: null,
    });
    // An access that lets the caller in, so the refusal seen is the inbox rule's.
    const open = { ...d, access: { project: async () => ({}) } as unknown as Access };
    await expect(testWebhook(open, who(true), PROJECT, HOOK)).rejects.toMatchObject({
      code: "webhook.sam_inbox_unavailable",
    });
  });
});

describe("dispatching a webhook aimed at sam's inbox", () => {
  const payload = { event: "conversation.transcribed", conversation: { id: "c1" } };
  const inboxHook = row({ url: "sam-inbox:echo_sales_call_transcript_v1" });

  const setup = (hook: WebhookRow, status = 200) => {
    const posted: SamEnvelope[] = [];
    const delivered: unknown[] = [];
    return {
      posted,
      delivered,
      deps: {
        store: { get: async () => hook } as unknown as WebhooksStorage,
        deliver: async (_t: unknown, p: unknown) => {
          delivered.push(p);
          return { status: 200, text: "" };
        },
        logger: quiet,
        inbox: async (e: SamEnvelope) => {
          posted.push(e);
          return { status, text: "" };
        },
      },
    };
  };

  test("sends the same payload under the code, with the run's id as the message id", async () => {
    const s = setup(inboxHook);
    await runDispatch(s.deps, { webhookId: HOOK, payload }, { id: "run-1" });
    await runDispatch(s.deps, { webhookId: HOOK, payload }, { id: "run-1" });
    expect(s.delivered).toHaveLength(0);
    expect(s.posted).toHaveLength(2);
    expect(s.posted[0]).toEqual({
      code: "echo_sales_call_transcript_v1",
      id: "run-1",
      body: JSON.stringify({ code: "echo_sales_call_transcript_v1", json: payload }),
    });
    // A retry of the same run is the same message.
    expect(s.posted[1]).toEqual(s.posted[0] as SamEnvelope);
  });

  test("a customer webhook still goes to its URL and never to the inbox", async () => {
    const s = setup(row());
    await runDispatch(s.deps, { webhookId: HOOK, payload }, { id: "run-2" });
    expect(s.posted).toHaveLength(0);
    expect(s.delivered).toEqual([payload]);
  });

  test("busy retries, a refusal does not, an unconfigured inbox fails the run", async () => {
    await expect(
      runDispatch(setup(inboxHook, 503).deps, { webhookId: HOOK, payload }, { id: "r" }),
    ).rejects.toBeInstanceOf(SamInboxRetry);
    await runDispatch(setup(inboxHook, 409).deps, { webhookId: HOOK, payload }, { id: "r" });
    await expect(
      runDispatch(
        { ...setup(inboxHook).deps, inbox: null },
        { webhookId: HOOK, payload },
        { id: "r" },
      ),
    ).rejects.toBeInstanceOf(SamInboxRetry);
  });
});

describe("customers cannot aim a webhook at the inbox", () => {
  test("the customer routes accept only http and https URLs", async () => {
    const { d } = deps();
    const open = { ...d, access: { project: async () => ({}) } as unknown as Access };
    const { createWebhook, updateWebhook } = await import("../src/service");
    await expect(
      createWebhook(open, who(false), PROJECT, {
        name: "x",
        url: "sam-inbox:echo_sales_call_transcript_v1",
        secret: null,
        events: ["conversation.transcribed"],
      }),
    ).rejects.toMatchObject({ code: "webhook.invalid_url" });
    await expect(
      updateWebhook(open, who(false), PROJECT, HOOK, {
        name: null,
        url: "sam-inbox:echo_sales_call_transcript_v1",
        secret: null,
        events: null,
        status: null,
      }),
    ).rejects.toMatchObject({ code: "webhook.invalid_url" });
  });
});
