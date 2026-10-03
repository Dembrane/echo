import { type Access, requireStaff, type StaffAudit } from "@dembrane/access";
import { BadRequestError, NotFoundError, newId } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectAllows, projectFor } from "@dembrane/http";
import { directusRow, pythonIso } from "@dembrane/legacy-shape";
import type { EnqueueOptions, JobSink } from "@dembrane/queue";
import { assertPublicTarget, type Deliver, DeliveryError } from "./deliver";
import { dispatchWebhook } from "./jobs";
import {
  conversationPayload,
  EVENTS_REPR,
  isWebhookEvent,
  reportPayload,
  type WebhookEvent,
} from "./payloads";
import { INBOX_SCHEME, inboxCodeOf } from "./sam-inbox";
import type { WebhookRow, WebhooksStorage } from "./storage";

export interface WebhookDeps {
  readonly store: WebhooksStorage;
  readonly access: Access;
  readonly jobs: JobSink;
  readonly deliver: Deliver;
  readonly now: () => Date;
  /** Global switch; off means events enqueue nothing. */
  readonly enabled: boolean;
  /** Local and test only: lets webhooks target loopback and private addresses. */
  readonly allowPrivateTargets: boolean;
  readonly dashboardUrl: string;
  /** Records staff changing a webhook's target; absent, no target can be changed. */
  readonly staffAudit?: StaffAudit;
  /** Whether SAM_INBOX_* is set, so a webhook can be aimed at sam's inbox. */
  readonly samInbox?: boolean;
}

/**
 * The codes a project webhook may deliver to sam's inbox under. Each is a payload sam has
 * a handler for; the conversation payload of dembrane's own sales calls is the only one.
 */
export const SAM_INBOX_WEBHOOK_CODES = ["echo_sales_call_transcript_v1"] as const;

/** Webhook settings need workspace:webhooks: admins and owners on changemaker or above. */
async function requireWebhooks(d: WebhookDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "workspace:webhooks");
  const project = await d.store.project(projectId);
  if (!project) throw new NotFoundError("project.not_found");
  return project;
}

function parseEvents(raw: unknown): string[] {
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

function view(w: WebhookRow) {
  const row = directusRow(w);
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: parseEvents(w.events),
    status: w.status,
    date_created: row.date_created ?? null,
    date_updated: row.date_updated ?? null,
  };
}

function checkEvents(events: string[]) {
  for (const e of events)
    if (!isWebhookEvent(e))
      throw new BadRequestError("webhook.invalid_event", {
        params: { event: e, valid: EVENTS_REPR },
      });
}

async function checkUrl(d: WebhookDeps, url: string) {
  if (!/^https?:\/\//.test(url)) throw new BadRequestError("webhook.invalid_url");
  try {
    await assertPublicTarget(url, d.allowPrivateTargets);
  } catch (err) {
    if (err instanceof DeliveryError)
      throw new BadRequestError("webhook.target_not_allowed", { message: err.message });
    throw err;
  }
}

/** Python's json.dumps(list) with default separators, as the events column has always held. */
const eventsJson = (events: string[]) => `[${events.map((e) => JSON.stringify(e)).join(", ")}]`;

export async function listWebhooks(d: WebhookDeps, who: Signed, projectId: string) {
  await requireWebhooks(d, who, projectId);
  return (await d.store.forProject(projectId)).map(view);
}

/** Webhooks of other projects the caller also manages webhooks on, to copy settings from. */
export async function copyableWebhooks(d: WebhookDeps, who: Signed, projectId: string) {
  await requireWebhooks(d, who, projectId);
  const allowed = new Map<string, boolean>();
  const out = [];
  for (const { w, projectId: pid, projectName } of await d.store.copyable(projectId)) {
    if (!allowed.has(pid))
      allowed.set(pid, await projectAllows(d.access, who, pid, "workspace:webhooks"));
    if (!allowed.get(pid)) continue;
    out.push({
      id: w.id,
      name: w.name,
      url: w.url,
      events: parseEvents(w.events),
      project_id: pid,
      project_name: projectName ?? "Unknown Project",
    });
  }
  return out;
}

export async function createWebhook(
  d: WebhookDeps,
  who: Signed,
  projectId: string,
  body: { name: string; url: string; secret: string | null; events: string[] },
) {
  await requireWebhooks(d, who, projectId);
  checkEvents(body.events);
  await checkUrl(d, body.url);
  const row = await d.store.insert({
    id: newId(),
    project_id: projectId,
    name: body.name,
    url: body.url,
    events: eventsJson(body.events),
    status: "published",
    ...(body.secret && { secret: body.secret }),
    user_created: who.directusUserId,
    date_created: d.now().toISOString(),
  });
  return { ...view(row), events: body.events };
}

export async function updateWebhook(
  d: WebhookDeps,
  who: Signed,
  projectId: string,
  webhookId: string,
  body: {
    name: string | null;
    url: string | null;
    secret: string | null;
    events: string[] | null;
    status: string | null;
  },
) {
  await requireWebhooks(d, who, projectId);
  if (body.events !== null) checkEvents(body.events);
  if (body.url !== null) await checkUrl(d, body.url);
  if (body.status !== null && !["published", "draft", "archived"].includes(body.status))
    throw new BadRequestError("webhook.invalid_status");
  const existing = await d.store.inProject(webhookId, projectId);
  if (!existing) throw new NotFoundError("webhook.not_found");
  const values = {
    ...(body.name !== null && { name: body.name }),
    ...(body.url !== null && { url: body.url }),
    ...(body.secret !== null && { secret: body.secret }),
    ...(body.events !== null && { events: eventsJson(body.events) }),
    ...(body.status !== null && { status: body.status }),
  };
  const updated = Object.keys(values).length
    ? await d.store.update(webhookId, {
        ...values,
        user_updated: who.directusUserId,
        date_updated: d.now().toISOString(),
      })
    : existing;
  return view(updated ?? existing);
}

/** Soft delete; delivery stops because dispatch reads the row at send time. */
export async function deleteWebhook(
  d: WebhookDeps,
  who: Signed,
  projectId: string,
  webhookId: string,
) {
  await requireWebhooks(d, who, projectId);
  if (!(await d.store.inProject(webhookId, projectId)))
    throw new NotFoundError("webhook.not_found");
  const now = d.now().toISOString();
  await d.store.update(webhookId, {
    deleted_at: now,
    date_updated: now,
    user_updated: who.directusUserId,
  });
}

/**
 * Aims a webhook at sam's inbox under a code, or back at a URL. Staff only and audited:
 * a project's conversations then reach sam, which only dembrane's own projects should do.
 * Events, status and secret are left as they are.
 */
export async function setWebhookTarget(
  d: WebhookDeps,
  who: Signed,
  projectId: string,
  webhookId: string,
  body: { target: string; code: string | null; url: string | null },
  requestId?: string,
) {
  if (!d.staffAudit) throw new Error("setWebhookTarget needs a staff audit");
  await requireStaff(d.staffAudit, who, {
    permission: "staff:webhooks",
    action: "project_webhook.target.update",
    targetType: "project_webhook",
    targetId: webhookId,
    detail: { project_id: projectId, target: body.target, code: body.code, url: body.url },
    ...(requestId && { requestId }),
  });
  const codes: readonly string[] = SAM_INBOX_WEBHOOK_CODES;
  const toInbox = body.target === "sam_inbox" && codes.includes(body.code ?? "") && !body.url;
  const toUrl = body.target === "url" && body.code === null && Boolean(body.url);
  if (!toInbox && !toUrl)
    throw new BadRequestError("webhook.invalid_target", { params: { codes: codes.join(", ") } });
  if (toInbox && !d.samInbox) throw new BadRequestError("webhook.sam_inbox_unavailable");
  if (toUrl) await checkUrl(d, body.url as string);
  const existing = await d.store.inProject(webhookId, projectId);
  if (!existing || existing.deleted_at) throw new NotFoundError("webhook.not_found");
  const updated = await d.store.update(webhookId, {
    url: toInbox ? `${INBOX_SCHEME}${body.code}` : body.url,
    user_updated: who.directusUserId,
    date_updated: d.now().toISOString(),
  });
  const row = updated ?? existing;
  const code = inboxCodeOf(row.url);
  return { ...view(row), target: code ? "sam_inbox" : "url", inbox_code: code };
}

/**
 * Sends a sample summarized-conversation payload, event `webhook.test`, and reports what
 * came back. The receiver's body is not echoed (spec M-22: the test turned the server
 * into a proxy that read internal responses).
 */
export async function testWebhook(
  d: WebhookDeps,
  who: Signed,
  projectId: string,
  webhookId: string,
) {
  const project = await requireWebhooks(d, who, projectId);
  const hook = await d.store.inProject(webhookId, projectId);
  if (!hook) throw new NotFoundError("webhook.not_found");
  // A sample would reach sam as a real message and post to a real channel.
  if (inboxCodeOf(hook.url)) throw new BadRequestError("webhook.sam_inbox_unavailable");
  const now = d.now();
  const iso = pythonIso(now);
  const payload = conversationPayload(
    "conversation.summarized",
    {
      id: "test-conversation-id",
      created_at: iso,
      updated_at: iso,
      participant_name: "Test Participant",
      duration: 120,
      source: "PORTAL_AUDIO",
      is_finished: true,
      is_all_chunks_transcribed: true,
      tags: [],
      summary: "This is a test summary for webhook testing.",
    },
    project,
    {
      transcript: "This is a test transcript for webhook testing.",
      emailsCsv: "test@example.com,another@example.com",
      dashboardUrl: d.dashboardUrl,
      now,
    },
  );
  const sample: Record<string, unknown> = { ...payload, event: "webhook.test" };
  try {
    const res = await d.deliver(
      { id: hook.id, name: hook.name, url: hook.url, secret: hook.secret },
      sample,
    );
    if (res.status >= 200 && res.status < 300)
      return {
        success: true,
        status_code: res.status,
        message: `Webhook responded successfully with status ${res.status}`,
      };
    return {
      success: false,
      status_code: res.status,
      message: `Webhook returned error status ${res.status}`,
    };
  } catch (err) {
    return {
      success: false,
      status_code: null,
      message: `Failed to connect to webhook: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Queues one delivery per published webhook of the project subscribed to a conversation
 * event. Called by the conversation pipeline; pass its transaction so the jobs commit with
 * the change that caused them.
 */
export async function enqueueConversationEvent(
  d: Pick<WebhookDeps, "store" | "jobs" | "now" | "enabled" | "dashboardUrl">,
  projectId: string,
  conversationId: string,
  event: WebhookEvent,
  opts: EnqueueOptions = {},
): Promise<number> {
  if (!d.enabled || !event.startsWith("conversation.")) return 0;
  const hooks = (await d.store.publishedForProject(projectId)).filter((h) =>
    parseEvents(h.events).includes(event),
  );
  if (!hooks.length) return 0;
  const [conversation, project] = [
    await d.store.conversation(conversationId),
    await d.store.project(projectId),
  ];
  if (!conversation || !project) return 0;
  const transcript =
    event === "conversation.transcribed" || event === "conversation.summarized"
      ? await d.store.transcript(conversationId)
      : undefined;
  const payload = conversationPayload(event, conversation, project, {
    ...(transcript !== undefined && { transcript }),
    emailsCsv: await d.store.emails(conversationId),
    dashboardUrl: d.dashboardUrl,
    now: d.now(),
  });
  for (const h of hooks) await d.jobs.enqueue(dispatchWebhook, { webhookId: h.id, payload }, opts);
  return hooks.length;
}

/** The same for report events, called when a report finishes generating. */
export async function enqueueReportEvent(
  d: Pick<WebhookDeps, "store" | "jobs" | "now" | "enabled" | "dashboardUrl">,
  projectId: string,
  reportId: number,
  event: WebhookEvent,
  opts: EnqueueOptions = {},
): Promise<number> {
  if (!d.enabled || event !== "report.generated") return 0;
  const hooks = (await d.store.publishedForProject(projectId)).filter((h) =>
    parseEvents(h.events).includes(event),
  );
  if (!hooks.length) return 0;
  const [report, project] = [
    await d.store.report(BigInt(reportId)),
    await d.store.project(projectId),
  ];
  if (!report || !project) return 0;
  const payload = reportPayload(event, report, project, {
    dashboardUrl: d.dashboardUrl,
    now: d.now(),
  });
  for (const h of hooks) await d.jobs.enqueue(dispatchWebhook, { webhookId: h.id, payload }, opts);
  return hooks.length;
}
