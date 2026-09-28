import { render } from "@echo/account";
import { newId } from "@echo/core";
import type { Db } from "@echo/db";
import type { Mailer } from "@echo/mail";
import type { Logger } from "@echo/observability";
import { defineJob, type JobDefinition, type Queue } from "@echo/queue";
import type { Deliver } from "@echo/webhooks";
import { z } from "zod";
import { refreshLegalTexts } from "./legal/store";
import type { AccountsJobs } from "./sink";
import { store } from "./storage";

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

/** Every 15 minutes: queue the reminders that fell due. */
export const remindersTick = defineJob("accounts.reminders-tick", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

/** One reminder email for one task at one due time (the run id is both). */
export const taskReminder = defineJob(
  "accounts.task-reminder",
  z.object({ taskId: z.string(), dueAt: z.string() }),
  { retryLimit: 3, retryDelaySeconds: 60, expireInSeconds: 120 },
);

/** Once a day: fetch the legal pages and store any text that changed. */
export const legalRefresh = defineJob("accounts.legal-refresh", z.object({}), {
  policy: "singleton",
  retryLimit: 1,
  retryDelaySeconds: 600,
  expireInSeconds: 5 * 60,
});

/** The jobs the API enqueues; its queue client creates exactly these. */
export const accountsApiJobs: readonly JobDefinition[] = [deliverEvent, notifySlack];

const DAY_MS = 86_400_000;

export function accountPageUrl(dashboardUrl: string, orgId: string): string {
  return `${dashboardUrl.replace(/\/+$/, "")}/o/${orgId}/account`;
}

/**
 * Claims each due reminder by moving the task's next reminder on by its interval, and
 * enqueues the email in the same transaction with the task and due time as the run id,
 * so a tick that runs twice (or overlaps a retry) sends one email per due time.
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
    // Never schedule into the past: a worker that was down catches up with one email.
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
  if (queued) d.logger.info({ reminders: queued }, "account task reminders queued");
  return queued;
}

/**
 * Sends one reminder, unless the task stopped waiting on the customer since it was queued.
 * Goes to the people who run the account (owners, admins, billing).
 */
export async function runTaskReminder(
  d: { db: Db; mailer: Mailer; logger: Logger; dashboardUrl: string; now: () => Date },
  p: { taskId: string; dueAt: string },
): Promise<"sent" | "skipped"> {
  const task = await store.taskById(d.db, p.taskId);
  if (!task || !["open", "changes_requested"].includes(task.status)) return "skipped";
  const org = await store.org(d.db, task.orgId);
  if (!org || org.deleted_at) return "skipped";
  const to = [
    ...new Set((await store.accountPeople(d.db, task.orgId)).map((p) => p.email).filter(Boolean)),
  ] as string[];
  if (!to.length) {
    d.logger.warn({ task_id: task.id, org_id: org.id }, "task reminder has nobody to go to");
    return "skipped";
  }
  const { html, text } = render({
    template: "account_task_reminder",
    data: {
      org_name: org.name,
      task_title: task.title,
      task_url: accountPageUrl(d.dashboardUrl, org.id),
    },
  });
  await d.mailer.send({
    to,
    subject: `Still open: ${task.title}`,
    html,
    text,
    tags: ["account_task_reminder"],
  });
  await d.db.transaction(async (tx) => {
    await store.updateTask(tx, task.id, { remindersSent: task.remindersSent + 1 });
    await store.insertEvent(tx, {
      id: newId(),
      orgId: org.id,
      actorKind: "system",
      actorUserId: null,
      type: "task.reminded",
      subjectType: "task",
      subjectId: task.id,
      detail: { due_at: p.dueAt, recipients: to.length },
      createdAt: d.now(),
    });
  });
  return "sent";
}

export async function runDeliverEvent(
  d: { deliver: Deliver; url: string | null; secret: string | null; logger: Logger },
  p: { payload: Record<string, unknown> },
): Promise<void> {
  if (!d.url) return;
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

export async function runNotifySlack(
  d: { post: PostJson; url: string | null },
  p: { text: string },
): Promise<void> {
  if (!d.url) return;
  const status = await d.post(d.url, { text: p.text });
  if (status < 200 || status >= 300) throw new Error(`Slack webhook answered ${status}`);
}

export interface AccountsWorkerDeps {
  readonly db: Db;
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly jobs: AccountsJobs;
  readonly deliver: Deliver;
  readonly dashboardUrl: string;
  readonly eventsUrl: string | null;
  readonly eventsSecret: string | null;
  readonly slackWebhookUrl: string | null;
  readonly reminderIntervalDays: number;
  readonly fetchText: (url: string) => Promise<string>;
  readonly post?: PostJson;
  readonly now?: () => Date;
}

/** The worker's registration: handlers and the two schedules. */
export function accountsWorker(deps: AccountsWorkerDeps) {
  const now = deps.now ?? (() => new Date());
  const jobs: JobDefinition[] = [
    deliverEvent,
    notifySlack,
    remindersTick,
    taskReminder,
    legalRefresh,
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
          },
          p,
        ),
      );
      await queue.work(notifySlack, { concurrency: 2 }, (p) =>
        runNotifySlack({ post: deps.post ?? httpPostJson, url: deps.slackWebhookUrl }, p),
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
            mailer: deps.mailer,
            logger: deps.logger,
            dashboardUrl: deps.dashboardUrl,
            now,
          },
          p,
        );
      });
      await queue.work(legalRefresh, { concurrency: 1 }, async () => {
        await refreshLegalTexts({
          db: deps.db,
          fetchText: deps.fetchText,
          logger: deps.logger,
          now,
        });
      });
      await queue.schedule(remindersTick, "*/15 * * * *", {});
      await queue.schedule(legalRefresh, "17 5 * * *", {});
    },
  };
}
