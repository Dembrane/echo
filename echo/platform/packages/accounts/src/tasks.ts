import { newId } from "@echo/core";
import type { AccountsDeps, Conn } from "./deps";
import type { Language } from "./offer";
import { store, type TaskRow } from "./storage";

const DAY_MS = 86_400_000;

export const TASK_KINDS = ["sign", "billing_details", "upload", "generic"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** Statuses in which a task waits on the customer, and so reminds them. */
export const WAITING_ON_CUSTOMER = ["open", "changes_requested"] as const;

export interface NewTask {
  /** A fixed id (demo seeds); otherwise a new one. */
  readonly id?: string;
  readonly orgId: string;
  readonly title: string;
  readonly body?: string | null;
  readonly kind: TaskKind;
  readonly documentId?: string | null;
  readonly dueOn?: string | null;
  readonly locked?: boolean;
  readonly unlockOnDocumentId?: string | null;
  readonly reminderIntervalDays?: number | null;
  readonly createdBy?: string | null;
}

/** The first reminder of a task that opens now. */
export function firstReminder(d: AccountsDeps, now: Date, interval: number | null | undefined) {
  return new Date(now.getTime() + (interval ?? d.settings.reminderIntervalDays) * DAY_MS);
}

export async function createTask(d: AccountsDeps, tx: Conn, t: NewTask): Promise<TaskRow> {
  const now = d.now();
  const id = t.id ?? newId();
  const locked = t.locked === true;
  await store.insertTask(tx, {
    id,
    orgId: t.orgId,
    title: t.title,
    body: t.body ?? null,
    kind: t.kind,
    documentId: t.documentId ?? null,
    unlockOnDocumentId: t.unlockOnDocumentId ?? null,
    dueOn: t.dueOn ?? null,
    status: locked ? "locked" : "open",
    openedAt: locked ? null : now,
    nextReminderAt: locked ? null : firstReminder(d, now, t.reminderIntervalDays),
    reminderIntervalDays: t.reminderIntervalDays ?? null,
    createdBy: t.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return (await store.taskById(tx, id)) as TaskRow;
}

/** Opens a locked task: it starts reminding from now. */
export async function unlockTask(d: AccountsDeps, tx: Conn, t: TaskRow): Promise<void> {
  const now = d.now();
  await store.updateTask(tx, t.id, {
    status: "open",
    openedAt: now,
    nextReminderAt: firstReminder(d, now, t.reminderIntervalDays),
    updatedAt: now,
  });
}

/** Ends a task's reminders: done, withdrawn, or waiting on us. */
export async function settleTask(
  d: AccountsDeps,
  tx: Conn,
  taskId: string,
  status: "done" | "withdrawn" | "submitted",
  extra: Parameters<typeof store.updateTask>[2] = {},
): Promise<void> {
  await store.updateTask(tx, taskId, {
    status,
    nextReminderAt: null,
    updatedAt: d.now(),
    ...extra,
  });
}

const BILLING_TITLE: Record<Language, string> = { en: "Billing details", nl: "Factuurgegevens" };
const BILLING_BODY: Record<Language, string> = {
  en: "Who we invoice: legal name, address, VAT or KvK number, billing email and, if you use one, your PO number. It opens once the offer is signed.",
  nl: "Aan wie we factureren: juridische naam, adres, btw- of KvK-nummer, factuur-e-mail en, als jullie die gebruiken, het PO-nummer. Deze stap opent zodra de offerte is ondertekend.",
};

/**
 * The billing details task exists from the start, locked until an offer is signed. Only
 * one is kept per organisation while it is not done or withdrawn.
 */
export async function ensureBillingTask(
  d: AccountsDeps,
  tx: Conn,
  orgId: string,
  language: Language,
  createdBy: string | null,
): Promise<void> {
  const live = (await store.tasks(tx, orgId)).some(
    (t) => t.kind === "billing_details" && !["done", "withdrawn"].includes(t.status),
  );
  if (live) return;
  await createTask(d, tx, {
    orgId,
    title: BILLING_TITLE[language],
    body: BILLING_BODY[language],
    kind: "billing_details",
    locked: true,
    createdBy,
  });
}
