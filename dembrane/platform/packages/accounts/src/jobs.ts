import type { Db } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import { defineJob, type JobDefinition, type Queue, step } from "@dembrane/queue";
import { type Deliver, enqueueSamMessage, type SamQueue } from "@dembrane/webhooks";
import { z } from "zod";
import { buildDemo, type DemoBuildDeps } from "./demo/build";
import { demoBuild } from "./demo/job";
import {
  ACCOUNT_EVENT_CODES,
  documentPayload,
  emit,
  type InboxEvent,
  inboxTakes,
  orgPayload,
  waitingTaskPayload,
} from "./events";
import {
  type InvoiceDeps,
  partsOf,
  requestInvoices,
  requestSubject,
  staffAccountUrl,
  staffDocumentUrl,
} from "./invoice";
import { amsterdamDay, dueOn } from "./invoice-plan";
import { refreshLegalTexts } from "./legal/store";
import type { AccountsJobs } from "./sink";
import { store } from "./storage";
import { WAITING_ON_CUSTOMER } from "./tasks";

/**
 * One account event to sam. The payload is built when the event happens, so a retry sends
 * the same body. 2xx is done; 4xx is sam refusing, logged and not retried; anything else
 * is retried with backoff.
 */
export const deliverEvent = defineJob(
  "accounts.deliver-event",
  z.object({ payload: z.record(z.string(), z.unknown()) }),
  { retryLimit: 6, retryDelaySeconds: 10, retryBackoff: true, expireInSeconds: 120 },
);

/** One line to the team's Slack channel. */
export const notifySlack = defineJob("accounts.notify-slack", z.object({ text: z.string() }), {
  retryLimit: 3,
  retryDelaySeconds: 30,
  expireInSeconds: 60,
});

/** Every 15 minutes: queue the check-ins that fell due. */
export const remindersTick = defineJob("accounts.reminders-tick", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

/**
 * One check-in asked of the account's owner, for one task at one due time (the run id is
 * both). The customer is not written to.
 */
export const taskReminder = defineJob(
  "accounts.task-reminder",
  z.object({ taskId: z.string(), dueAt: z.string() }),
  { retryLimit: 3, retryDelaySeconds: 60, expireInSeconds: 120 },
);

/**
 * Every hour: ask for the invoice of each part of a signed offer whose day has come. The
 * first part goes with the signature; this catches the later ones.
 */
export const invoicePartsTick = defineJob("accounts.invoice-parts-tick", z.object({}), {
  policy: "singleton",
  retryLimit: 2,
  retryDelaySeconds: 300,
  expireInSeconds: 5 * 60,
});

/** Once a day: fetch the legal pages and store any text that changed. */
export const legalRefresh = defineJob("accounts.legal-refresh", z.object({}), {
  policy: "singleton",
  retryLimit: 1,
  retryDelaySeconds: 600,
  expireInSeconds: 5 * 60,
});

/** The jobs the API enqueues; its queue client creates exactly these. */
export const accountsApiJobs: readonly JobDefinition[] = [deliverEvent, notifySlack, demoBuild];

const DAY_MS = 86_400_000;

/** The dashboard address without the slashes it may end in. */
export function dashboardBase(dashboardUrl: string): string {
  let end = dashboardUrl.length;
  while (end > 0 && dashboardUrl[end - 1] === "/") end--;
  return dashboardUrl.slice(0, end);
}

export function accountPageUrl(dashboardUrl: string, orgId: string): string {
  return `${dashboardBase(dashboardUrl)}/o/${orgId}/account`;
}

/**
 * Claims each due check-in by moving the task's next one on by its interval, and enqueues
 * it in the same transaction with the task and due time as the run id, so a tick that runs
 * twice (or overlaps a retry) asks once per due time.
 */
export async function runRemindersTick(d: {
  db: Db;
  jobs: AccountsJobs;
  now: () => Date;
  intervalDays: number;
  logger: Logger;
}): Promise<number> {
  const now = d.now();
  let queued = 0;
  for (const task of await store.dueReminders(d.db, now, 200)) {
    const due = task.nextReminderAt as Date;
    const days = task.reminderIntervalDays ?? d.intervalDays;
    // Never schedule into the past: a worker that was down catches up with one ask.
    let next = new Date(due.getTime() + days * DAY_MS);
    while (next <= now) next = new Date(next.getTime() + days * DAY_MS);
    await d.db.transaction(async (tx) => {
      await store.updateTask(tx, task.id, { nextReminderAt: next, updatedAt: now });
      await d.jobs.enqueue(
        taskReminder,
        { taskId: task.id, dueAt: due.toISOString() },
        { tx, workflowId: `accounts.reminder:${task.id}:${due.toISOString()}` },
      );
    });
    queued++;
  }
  if (queued) d.logger.info({ check_ins: queued }, "account task check-ins queued");
  return queued;
}

/**
 * Asks for every part whose day has come. Each organisation with one is handled in its own
 * transaction under its lock, the way a signature or a billing save asks (requestInvoices),
 * and the request is recorded in that transaction: a tick that runs twice, a retry, or a
 * signature at the same moment asks once per part. Returns the organisations asked for.
 */
export async function runInvoicePartsTick(d: {
  db: Db;
  jobs: AccountsJobs;
  now: () => Date;
  logger: Logger;
  settings: InvoiceDeps["settings"];
}): Promise<string[]> {
  if (!d.settings.offerMessages) return [];
  const today = amsterdamDay(d.now());
  const { docs, asked } = await store.offersInParts(d.db);
  const orgs = new Set<string>();
  for (const doc of docs) {
    if (orgs.has(doc.orgId) || !doc.signedAt) continue;
    const signedOn = amsterdamDay(doc.signedAt);
    const due = partsOf(doc).some(
      (p) => !asked.has(requestSubject(doc, p).id) && dueOn(p.due, signedOn) <= today,
    );
    if (due) orgs.add(doc.orgId);
  }
  const done: string[] = [];
  for (const orgId of orgs) {
    await d.db.transaction(async (tx) => {
      await store.lockOrg(tx, orgId);
      const org = await store.org(tx, orgId);
      if (!org || org.deleted_at) return;
      const asked = await requestInvoices(
        { jobs: d.jobs, now: d.now, settings: d.settings },
        tx,
        org,
      );
      if (asked.length) done.push(orgId);
    });
  }
  if (done.length) d.logger.info({ organisations: done.length }, "invoice parts asked for");
  return done;
}

/**
 * A task has waited on the customer for its interval: the account's owner at dembrane is
 * asked to check in, through sam, unless the task stopped waiting since this was queued.
 * The customer gets nothing from echo; whether and how to write them is the owner's call.
 *
 * Where no inbox takes the message (inboxTakes) nobody is asked and nothing is recorded,
 * so the count and the timeline only ever say what happened; the next due time asks again.
 */
export async function runTaskReminder(
  d: {
    db: Db;
    jobs: AccountsJobs;
    logger: Logger;
    dashboardUrl: string;
    now: () => Date;
    samInbox: boolean;
    offerMessages: boolean;
  },
  p: { taskId: string; dueAt: string },
): Promise<"asked" | "skipped"> {
  const task = await store.taskById(d.db, p.taskId);
  if (!task || !(WAITING_ON_CUSTOMER as readonly string[]).includes(task.status)) return "skipped";
  const org = await store.org(d.db, task.orgId);
  if (!org || org.deleted_at) return "skipped";
  const settings = {
    samInbox: d.samInbox,
    offerMessages: d.offerMessages,
    eventsEnabled: false,
    slackEnabled: false,
  };
  if (!inboxTakes(settings, "account.task.waiting")) {
    d.logger.info(
      { signal: "accounts.task_waiting_untold", task_id: task.id, org_id: org.id },
      "a task waits on the customer and no inbox takes the check-in",
    );
    return "skipped";
  }
  const doc = task.documentId ? await store.document(d.db, org.id, task.documentId) : null;
  const timesAsked = task.remindersSent + 1;
  const waiting = waitingTaskPayload(task, d.now(), timesAsked);
  await d.db.transaction(async (tx) => {
    await store.updateTask(tx, task.id, { remindersSent: timesAsked });
    await emit({ jobs: d.jobs, now: d.now, settings }, tx, {
      orgId: org.id,
      actor: { kind: "system", userId: null },
      type: "task.check_in_asked",
      subject: { type: "task", id: task.id },
      detail: { due_at: p.dueAt, days_waiting: waiting.days_waiting, times_asked: timesAsked },
      webhook: {
        event: "account.task.waiting",
        org: orgPayload(org),
        task: waiting,
        document: doc ? { ...documentPayload(doc), status: doc.status } : null,
        /** The people who run the account on the customer's side, in the order they joined. */
        contacts: await customerContacts(tx, org.id),
        links: {
          /** The organisation's card in the staff console. */
          account: staffAccountUrl(d.dashboardUrl, org.id),
          /** The task's document as staff see it, when it has one. */
          document: doc ? staffDocumentUrl(d.dashboardUrl, org.id, doc.id) : null,
          /** Where the customer does the task, after signing in. */
          customer: accountPageUrl(d.dashboardUrl, org.id),
        },
      },
    });
  });
  return "asked";
}

/** Owners, admins and billing members with an address, each address once. */
async function customerContacts(
  c: Parameters<typeof store.accountPeople>[0],
  orgId: string,
): Promise<{ name: string | null; email: string; role: string }[]> {
  const seen = new Set<string>();
  const out: { name: string | null; email: string; role: string }[] = [];
  for (const p of await store.accountPeople(c, orgId)) {
    const address = p.email?.trim().toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ name: p.name || null, email: p.email as string, role: p.role });
  }
  return out;
}

/**
 * Sends one queued account event. With sam's inbox configured it is moved onto the inbox
 * under its timeline id, so events queued before the switch still reach sam. With neither
 * the inbox nor ACCOUNTS_EVENTS_URL set the run fails instead of succeeding unsent: such a
 * job was queued while a receiver was set, and removing it must not drop the event.
 */
export async function runDeliverEvent(
  d: {
    deliver: Deliver;
    url: string | null;
    secret: string | null;
    logger: Logger;
    inbox?: SamQueue | null;
  },
  p: { payload: Record<string, unknown> },
): Promise<void> {
  if (d.inbox) {
    const code = ACCOUNT_EVENT_CODES[p.payload.event as InboxEvent];
    if (!code) throw new Error(`no sam inbox code for account event ${String(p.payload.event)}`);
    await enqueueSamMessage(d.inbox, { code, json: p.payload, id: String(p.payload.id) });
    return;
  }
  if (!d.url)
    throw new Error(
      "account event queued but neither SAM_INBOX_URL nor ACCOUNTS_EVENTS_URL is set; restore one to deliver it",
    );
  const res = await d.deliver(
    { id: "accounts", name: "sam", url: d.url, secret: d.secret },
    p.payload,
  );
  if (res.status >= 200 && res.status < 300) return;
  if (res.status >= 400 && res.status < 500) {
    d.logger.warn(
      { status: res.status, event: p.payload.event, body: res.text.slice(0, 200) },
      "account event refused by receiver, not retrying",
    );
    return;
  }
  throw new Error(`account event receiver answered ${res.status}`);
}

export type PostJson = (url: string, body: unknown) => Promise<number>;

export const httpPostJson: PostJson = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return res.status;
};

/**
 * Posts one queued Slack line. Unset with sam's inbox on, the line is dropped: sam posts
 * account notices from the inbox. Unset without it, the run fails rather than losing it.
 */
export async function runNotifySlack(
  d: { post: PostJson; url: string | null; samInbox?: boolean; logger?: Logger },
  p: { text: string },
): Promise<void> {
  if (!d.url) {
    if (d.samInbox) {
      d.logger?.info({ signal: "accounts.slack_left_to_sam" }, "queued Slack line left to sam");
      return;
    }
    throw new Error("Slack line queued but ACCOUNTS_SLACK_WEBHOOK_URL is unset; restore it");
  }
  const status = await d.post(d.url, { text: p.text });
  if (status < 200 || status >= 300) throw new Error(`Slack webhook answered ${status}`);
}

export interface AccountsWorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly jobs: AccountsJobs;
  readonly deliver: Deliver;
  readonly dashboardUrl: string;
  readonly eventsUrl: string | null;
  readonly eventsSecret: string | null;
  /** SAM_INBOX_* is set: queued account events drain through the inbox. */
  readonly samInbox?: boolean;
  /** ACCOUNTS_OFFER_MESSAGES: sam takes the check-in for a task that waits on a customer. */
  readonly offerMessages?: boolean;
  readonly slackWebhookUrl: string | null;
  readonly reminderIntervalDays: number;
  readonly fetchText: (url: string) => Promise<string>;
  readonly post?: PostJson;
  readonly now?: () => Date;
  /**
   * Demos made in echo: everything the build workflow needs, made once the queue exists
   * (the popcorn read enqueues through it). Absent, the worker does not build demos.
   */
  readonly demos?: (queue: Queue) => DemoBuildDeps;
}

/** The worker's registration: handlers and the three schedules. */
export function accountsWorker(deps: AccountsWorkerDeps) {
  const now = deps.now ?? (() => new Date());
  const jobs: JobDefinition[] = [
    deliverEvent,
    notifySlack,
    remindersTick,
    taskReminder,
    legalRefresh,
    invoicePartsTick,
  ];
  return {
    jobs,
    async register(queue: Queue) {
      await queue.work(deliverEvent, { concurrency: 5 }, (p) =>
        runDeliverEvent(
          {
            deliver: deps.deliver,
            url: deps.eventsUrl,
            secret: deps.eventsSecret,
            logger: deps.logger,
            inbox: deps.samInbox ? queue : null,
          },
          p,
        ),
      );
      await queue.work(notifySlack, { concurrency: 2 }, (p) =>
        runNotifySlack(
          {
            post: deps.post ?? httpPostJson,
            url: deps.slackWebhookUrl,
            samInbox: Boolean(deps.samInbox),
            logger: deps.logger,
          },
          p,
        ),
      );
      await queue.work(remindersTick, { concurrency: 1 }, async () => {
        await runRemindersTick({
          db: deps.db,
          jobs: deps.jobs,
          now,
          intervalDays: deps.reminderIntervalDays,
          logger: deps.logger,
        });
      });
      await queue.work(taskReminder, { concurrency: 5 }, async (p) => {
        await runTaskReminder(
          {
            db: deps.db,
            jobs: deps.jobs,
            logger: deps.logger,
            dashboardUrl: deps.dashboardUrl,
            now,
            samInbox: Boolean(deps.samInbox),
            offerMessages: Boolean(deps.offerMessages),
          },
          p,
        );
      });
      await queue.work(invoicePartsTick, { concurrency: 1 }, async () => {
        await runInvoicePartsTick({
          db: deps.db,
          jobs: deps.jobs,
          now,
          logger: deps.logger,
          settings: {
            dashboardUrl: deps.dashboardUrl,
            offerMessages: Boolean(deps.offerMessages),
            samInbox: Boolean(deps.samInbox),
            eventsEnabled: Boolean(deps.eventsUrl),
            slackEnabled: Boolean(deps.slackWebhookUrl),
          },
        });
      });
      await queue.work(legalRefresh, { concurrency: 1 }, async () => {
        await refreshLegalTexts({
          db: deps.db,
          fetchText: deps.fetchText,
          logger: deps.logger,
          now,
        });
      });
      if (deps.demos) {
        const demoDeps = deps.demos(queue);
        // A durable workflow: each step is checkpointed, and the demo row records which are
        // done, so a crash resumes mid-way and a retry starts at the failed step.
        await queue.workflow(demoBuild, { concurrency: 2 }, async (p) => {
          await buildDemo(demoDeps, p.demoId, p.attempt, (name, fn) => step(name, fn));
        });
      }
      await queue.schedule(remindersTick, "*/15 * * * *", {});
      await queue.schedule(legalRefresh, "17 5 * * *", {});
      await queue.schedule(invoicePartsTick, "7 * * * *", {});
    },
  };
}
