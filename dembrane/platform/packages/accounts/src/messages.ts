import { type EmailTemplate, render, sendEmail, subjectOf } from "@dembrane/account";
import { ConflictError, NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import type { z } from "zod";
import { assertPersonSends, staffOrg } from "./access";
import type { SendMessageRequest, SendMessageResponse } from "./contract";
import type { AccountsDeps } from "./deps";
import { accountManagerPayload, emit } from "./events";
import { accountPageUrl } from "./jobs";
import { accountRecipients } from "./recipients";
import { store } from "./storage";
import { taskBody, taskTitle } from "./task-text";
import { WAITING_ON_CUSTOMER } from "./tasks";

/**
 * The emails an account manager sends from the staff card to the people who run an
 * account: a document withdrawn, a check-in on a task that waits on them. sam only tells
 * the manager (Slack); the manager decides and sends. echo reads the facts from its own
 * tables, words them in each recipient's language and draws them in the email frame, so
 * every message looks and reads like the rest of dembrane. Signed by the account's
 * manager, replies reaching them. Invoices are not among them: Exact sends those.
 */
export async function sendMessage(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  m: z.output<typeof SendMessageRequest>,
): Promise<z.output<typeof SendMessageResponse>> {
  // A dry run shows the emails and sends none.
  if (!m.dry_run) assertPersonSends(who);
  const org = await staffOrg(d, orgId);
  const manager = await accountManagerPayload(d.db, org.id);
  const recipients = await accountRecipients(d.db, org.id);
  const base = {
    org_name: org.name,
    account_url: accountPageUrl(d.settings.dashboardUrl, org.id),
    ...(manager?.name && { manager_name: manager.name }),
    ...(m.note && { note: m.note }),
  };

  let subjectId: { type: string; id: string };
  let build: (language: string) => EmailTemplate;
  if (m.kind === "task_reminder") {
    const task = m.task_id ? await store.task(d.db, org.id, m.task_id) : null;
    if (!task) throw new NotFoundError("task.not_found");
    if (!(WAITING_ON_CUSTOMER as readonly string[]).includes(task.status))
      throw new ConflictError("task.not_waiting");
    subjectId = { type: "task", id: task.id };
    build = (language) => {
      const lang = language as Parameters<typeof taskTitle>[1];
      const body = taskBody(task, lang);
      return {
        template: "account_task_reminder",
        data: { ...base, task_title: taskTitle(task, lang), ...(body && { task_body: body }) },
      };
    };
  } else {
    const doc = m.document_id ? await store.document(d.db, org.id, m.document_id) : null;
    if (!doc) throw new NotFoundError("document.not_found");
    subjectId = { type: "document", id: doc.id };
    if (doc.status !== "void") throw new ConflictError("document.not_withdrawn");
    const data = { ...base, document_title: doc.title };
    build = () => ({ template: "account_document_withdrawn", data });
  }

  const messages = recipients.map((r) => {
    const t = build(r.language);
    return {
      to: r.email,
      language: r.language,
      subject: subjectOf(t, r.language) ?? "",
      template: t,
      ...render(t, r.language),
    };
  });
  const shown = messages.map(({ template: _, ...rest }) => rest);
  if (m.dry_run || !messages.length) return { queued: 0, messages: shown };

  await d.db.transaction(async (tx) => {
    for (const [i, msg] of messages.entries()) {
      const r = recipients[i] as (typeof recipients)[number];
      await d.jobs.enqueue(
        sendEmail,
        {
          to: msg.to,
          subject: msg.subject,
          template: msg.template.template,
          data: msg.template.data as unknown as Record<string, string>,
          language: msg.language,
          context: `account message ${m.kind} ${subjectId.id}`,
          ...(manager && { replyTo: manager }),
        },
        // One withdrawal reaches one person once; check-ins may repeat.
        m.kind === "task_reminder"
          ? { tx }
          : { tx, workflowId: `accounts.message:${m.kind}:${subjectId.id}:${r.appUserId}` },
      );
    }
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "staff", userId: who.directusUserId },
      type: "message.sent",
      subject: subjectId,
      detail: { kind: m.kind, to: messages.map((x) => x.to), note: m.note },
    });
  });
  return { queued: messages.length, messages: shown };
}
