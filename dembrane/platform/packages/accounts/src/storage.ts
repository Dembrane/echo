import { schema } from "@dembrane/db";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Conn } from "./deps";

const {
  org,
  org_membership,
  org_invite,
  workspace_invite,
  app_user,
  auth_user,
  billing_account,
  pricing_configuration,
  account_document: doc,
  account_signature: signature,
  account_document_field: field,
  account_task: task,
  account_ticket: ticket,
  account_ticket_message: message,
  account_event: event,
  legal_text,
  legal_text_source,
  workspace,
  project,
} = schema;

/** Statuses in which a task still waits on the customer. */
const OPEN = ["open", "changes_requested"] as const;
/**
 * Not a synthetic demo (its popcorn session says so) and not a seeded sample copy: the
 * conversations of both are invented, and neither is a project the customer made.
 */
const NOT_SYNTHETIC = sql`not p.is_sample and not exists (select 1 from agent_loop l
  where l.project_id = p.id and l.popcorn_state->'demo'->>'synthetic' = 'true')`;

export type OrgRow = typeof org.$inferSelect;
export type BillingRow = typeof billing_account.$inferSelect;
export type DocumentRow = typeof doc.$inferSelect;
export type SignatureRow = typeof signature.$inferSelect;
export type FieldRow = typeof field.$inferSelect;
export type TaskRow = typeof task.$inferSelect;
export type TicketRow = typeof ticket.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
export type EventRow = typeof event.$inferSelect;
export type LegalRow = typeof legal_text.$inferSelect;

/** Drizzle queries only; every method takes the organisation first where it has one. */
export const store = {
  async org(c: Conn, id: string): Promise<OrgRow | null> {
    const [row] = await c.select().from(org).where(eq(org.id, id)).limit(1);
    return row ?? null;
  },

  async insertOrg(c: Conn, row: typeof org.$inferInsert) {
    await c.insert(org).values(row);
  },

  async updateOrg(c: Conn, id: string, patch: Partial<typeof org.$inferInsert>) {
    await c.update(org).set(patch).where(eq(org.id, id));
  },

  /** The organisation's own billing account (the oldest live one scoped to the org). */
  async billing(c: Conn, orgId: string): Promise<BillingRow | null> {
    const [row] = await c
      .select()
      .from(billing_account)
      .where(and(eq(billing_account.org_id, orgId), isNull(billing_account.deleted_at)))
      .orderBy(asc(billing_account.created_at))
      .limit(1);
    return row ?? null;
  },

  async insertBilling(c: Conn, row: typeof billing_account.$inferInsert) {
    await c.insert(billing_account).values(row);
  },

  async updateBilling(c: Conn, id: string, patch: Partial<typeof billing_account.$inferInsert>) {
    await c.update(billing_account).set(patch).where(eq(billing_account.id, id));
  },

  async pricingByReference(c: Conn, reference: string) {
    const [row] = await c
      .select()
      .from(pricing_configuration)
      .where(eq(pricing_configuration.reference, reference))
      .limit(1);
    return row ?? null;
  },

  async pricingById(c: Conn, id: string) {
    const [row] = await c
      .select()
      .from(pricing_configuration)
      .where(eq(pricing_configuration.id, id))
      .limit(1);
    return row ?? null;
  },

  async linkPricing(c: Conn, pricingId: string, orgId: string) {
    await c
      .update(pricing_configuration)
      .set({ org_id: orgId })
      .where(eq(pricing_configuration.id, pricingId));
  },

  // ── people ────────────────────────────────────────────────────────────

  /** A signed-in user's own address, from Better Auth (verified by code or link). */
  async identity(c: Conn, userId: string) {
    const [row] = await c
      .select({ email: auth_user.email, verified: auth_user.emailVerified, name: auth_user.name })
      .from(auth_user)
      .where(eq(auth_user.id, userId))
      .limit(1);
    return row ?? null;
  },

  async identityByEmail(c: Conn, email: string) {
    const [row] = await c
      .select({ id: auth_user.id })
      .from(auth_user)
      .where(sql`lower(${auth_user.email}) = ${email.toLowerCase()}`)
      .limit(1);
    return row ?? null;
  },

  async appUserByDirectusId(c: Conn, directusUserId: string) {
    const [row] = await c
      .select()
      .from(app_user)
      .where(eq(app_user.directus_user_id, directusUserId))
      .limit(1);
    return row ?? null;
  },

  async appUser(c: Conn, id: string) {
    const [row] = await c.select().from(app_user).where(eq(app_user.id, id)).limit(1);
    return row ?? null;
  },

  async orgMembership(c: Conn, orgId: string, appUserId: string) {
    const [row] = await c
      .select()
      .from(org_membership)
      .where(and(eq(org_membership.org_id, orgId), eq(org_membership.user_id, appUserId)))
      .orderBy(asc(org_membership.created_at))
      .limit(1);
    return row ?? null;
  },

  /** Members who run the account (owner, admin, billing), their addresses and languages. */
  async accountPeople(c: Conn, orgId: string) {
    return c
      .select({
        appUserId: app_user.id,
        email: sql<string | null>`coalesce(${auth_user.email}, ${app_user.email})`,
        name: app_user.display_name,
        role: org_membership.role,
        language: schema.directus_users.language,
      })
      .from(org_membership)
      .innerJoin(app_user, eq(app_user.id, org_membership.user_id))
      .leftJoin(auth_user, eq(auth_user.id, app_user.directus_user_id))
      .leftJoin(schema.directus_users, eq(schema.directus_users.id, app_user.directus_user_id))
      .where(
        and(
          eq(org_membership.org_id, orgId),
          isNull(org_membership.deleted_at),
          inArray(org_membership.role, ["owner", "admin", "billing"]),
        ),
      )
      .orderBy(asc(org_membership.created_at));
  },

  async members(c: Conn, orgId: string) {
    return c
      .select({
        appUserId: app_user.id,
        email: sql<string | null>`coalesce(${auth_user.email}, ${app_user.email})`,
        name: app_user.display_name,
        role: org_membership.role,
        since: org_membership.created_at,
      })
      .from(org_membership)
      .innerJoin(app_user, eq(app_user.id, org_membership.user_id))
      .leftJoin(auth_user, eq(auth_user.id, app_user.directus_user_id))
      .where(and(eq(org_membership.org_id, orgId), isNull(org_membership.deleted_at)))
      .orderBy(asc(org_membership.created_at));
  },

  async usage(c: Conn, orgId: string) {
    const [row] = await c
      .select({
        workspaces: sql<number>`count(distinct ${workspace.id})::int`,
        projects: sql<number>`count(distinct ${project.id})::int`,
      })
      .from(workspace)
      .leftJoin(project, and(eq(project.workspace_id, workspace.id), isNull(project.deleted_at)))
      .where(and(eq(workspace.org_id, orgId), isNull(workspace.deleted_at)));
    return row ?? { workspaces: 0, projects: 0 };
  },

  /**
   * Who may be sent a sign-in code: an existing account, a pending invitation to an
   * organisation or workspace, or a person named to sign a document still waiting for them.
   */
  async mayReceiveCode(c: Conn, email: string, now: Date): Promise<boolean> {
    const e = email.trim().toLowerCase();
    const at = now.toISOString();
    const [user] = await c
      .select({ id: auth_user.id, status: schema.directus_users.status })
      .from(auth_user)
      .leftJoin(schema.directus_users, eq(schema.directus_users.id, auth_user.id))
      .where(sql`lower(${auth_user.email}) = ${e}`)
      .limit(1);
    // A contact held back (a demo not yet published) or a suspended user gets no code.
    if (user) return !["draft", "suspended", "archived"].includes(user.status ?? "active");
    const [orgInvite] = await c
      .select({ id: org_invite.id })
      .from(org_invite)
      .where(
        and(
          sql`lower(${org_invite.email}) = ${e}`,
          isNull(org_invite.accepted_at),
          isNull(org_invite.deleted_at),
          gt(org_invite.expires_at, at),
        ),
      )
      .limit(1);
    if (orgInvite) return true;
    const [wsInvite] = await c
      .select({ id: workspace_invite.id })
      .from(workspace_invite)
      .where(
        and(
          sql`lower(${workspace_invite.email}) = ${e}`,
          isNull(workspace_invite.accepted_at),
          isNull(workspace_invite.deleted_at),
          gt(workspace_invite.expires_at, at),
        ),
      )
      .limit(1);
    if (wsInvite) return true;
    const [signer] = await c
      .select({ id: doc.id })
      .from(doc)
      .where(and(sql`lower(${doc.signerEmail}) = ${e}`, inArray(doc.status, ["sent", "viewed"])))
      .limit(1);
    return Boolean(signer);
  },

  /** Documents waiting for this person's signature, in any organisation. */
  async waitingForSigner(c: Conn, email: string): Promise<DocumentRow[]> {
    return c
      .select()
      .from(doc)
      .where(
        and(
          sql`lower(${doc.signerEmail}) = ${email.trim().toLowerCase()}`,
          inArray(doc.status, ["sent", "viewed"]),
        ),
      )
      .orderBy(desc(doc.sentAt));
  },

  // ── documents ─────────────────────────────────────────────────────────

  async documents(c: Conn, orgId: string) {
    return c
      .select()
      .from(doc)
      .where(eq(doc.orgId, orgId))
      .orderBy(desc(doc.createdAt), desc(doc.id));
  },

  async document(c: Conn, orgId: string, id: string): Promise<DocumentRow | null> {
    const [row] = await c
      .select()
      .from(doc)
      .where(and(eq(doc.orgId, orgId), eq(doc.id, id)))
      .limit(1);
    return row ?? null;
  },

  /** Row-locked read inside a transaction, so two signatures cannot race. */
  async documentForUpdate(c: Conn, orgId: string, id: string): Promise<DocumentRow | null> {
    const [row] = await c
      .select()
      .from(doc)
      .where(and(eq(doc.orgId, orgId), eq(doc.id, id)))
      .for("update")
      .limit(1);
    return row ?? null;
  },

  async documentByExactId(c: Conn, exactId: string): Promise<DocumentRow | null> {
    const [row] = await c.select().from(doc).where(eq(doc.exactId, exactId)).limit(1);
    return row ?? null;
  },

  async insertDocument(c: Conn, row: typeof doc.$inferInsert) {
    await c.insert(doc).values(row);
  },

  async updateDocument(c: Conn, id: string, patch: Partial<typeof doc.$inferInsert>) {
    await c.update(doc).set(patch).where(eq(doc.id, id));
  },

  async fields(c: Conn, documentId: string): Promise<FieldRow[]> {
    return c
      .select()
      .from(field)
      .where(eq(field.documentId, documentId))
      .orderBy(asc(field.sort), asc(field.id));
  },

  /** Replaces a draft document's fields (the trigger refuses this once it is sent). */
  async setFields(c: Conn, documentId: string, rows: (typeof field.$inferInsert)[]) {
    await c.delete(field).where(eq(field.documentId, documentId));
    if (rows.length) await c.insert(field).values(rows);
  },

  async signatures(c: Conn, orgId: string): Promise<SignatureRow[]> {
    return c.select().from(signature).where(eq(signature.orgId, orgId));
  },

  async signatureOf(c: Conn, documentId: string): Promise<SignatureRow | null> {
    const [row] = await c
      .select()
      .from(signature)
      .where(eq(signature.documentId, documentId))
      .limit(1);
    return row ?? null;
  },

  async insertSignature(c: Conn, row: typeof signature.$inferInsert) {
    await c.insert(signature).values(row);
  },

  // ── tasks ─────────────────────────────────────────────────────────────

  async tasks(c: Conn, orgId: string): Promise<TaskRow[]> {
    return c
      .select()
      .from(task)
      .where(eq(task.orgId, orgId))
      .orderBy(asc(task.createdAt), asc(task.id));
  },

  async task(c: Conn, orgId: string, id: string): Promise<TaskRow | null> {
    const [row] = await c
      .select()
      .from(task)
      .where(and(eq(task.orgId, orgId), eq(task.id, id)))
      .limit(1);
    return row ?? null;
  },

  async taskById(c: Conn, id: string): Promise<TaskRow | null> {
    const [row] = await c.select().from(task).where(eq(task.id, id)).limit(1);
    return row ?? null;
  },

  async insertTask(c: Conn, row: typeof task.$inferInsert) {
    await c.insert(task).values(row);
  },

  async updateTask(c: Conn, id: string, patch: Partial<typeof task.$inferInsert>) {
    await c.update(task).set(patch).where(eq(task.id, id));
  },

  /** Tasks that open once `documentId` (or, for unbound ones, any offer) is signed. */
  async lockedTasks(c: Conn, orgId: string, documentId: string): Promise<TaskRow[]> {
    return c
      .select()
      .from(task)
      .where(
        and(
          eq(task.orgId, orgId),
          eq(task.status, "locked"),
          or(eq(task.unlockOnDocumentId, documentId), isNull(task.unlockOnDocumentId)),
        ),
      );
  },

  /** Open tasks whose reminder is due, oldest first. Tasks waiting on us are not here. */
  async dueReminders(c: Conn, now: Date, limit: number): Promise<TaskRow[]> {
    return c
      .select()
      .from(task)
      .where(
        and(
          inArray(task.status, ["open", "changes_requested"]),
          isNotNull(task.nextReminderAt),
          lte(task.nextReminderAt, now),
        ),
      )
      .orderBy(asc(task.nextReminderAt))
      .limit(limit);
  },

  // ── tickets ───────────────────────────────────────────────────────────

  async tickets(c: Conn, orgId: string): Promise<TicketRow[]> {
    return c
      .select()
      .from(ticket)
      .where(eq(ticket.orgId, orgId))
      .orderBy(desc(ticket.updatedAt), desc(ticket.id));
  },

  async ticket(c: Conn, orgId: string, id: string): Promise<TicketRow | null> {
    const [row] = await c
      .select()
      .from(ticket)
      .where(and(eq(ticket.orgId, orgId), eq(ticket.id, id)))
      .limit(1);
    return row ?? null;
  },

  async messages(c: Conn, ticketIds: readonly string[]): Promise<MessageRow[]> {
    if (!ticketIds.length) return [];
    return c
      .select()
      .from(message)
      .where(inArray(message.ticketId, [...ticketIds]))
      .orderBy(asc(message.createdAt), asc(message.id));
  },

  async insertTicket(c: Conn, row: typeof ticket.$inferInsert) {
    await c.insert(ticket).values(row);
  },

  async updateTicket(c: Conn, id: string, patch: Partial<typeof ticket.$inferInsert>) {
    await c.update(ticket).set(patch).where(eq(ticket.id, id));
  },

  async insertMessage(c: Conn, row: typeof message.$inferInsert) {
    await c.insert(message).values(row);
  },

  // ── timeline ──────────────────────────────────────────────────────────

  async events(c: Conn, orgId: string, limit = 200): Promise<EventRow[]> {
    return c
      .select()
      .from(event)
      .where(eq(event.orgId, orgId))
      .orderBy(desc(event.createdAt), desc(event.id))
      .limit(limit);
  },

  async insertEvent(c: Conn, row: typeof event.$inferInsert) {
    await c.insert(event).values(row);
  },

  // ── legal texts ───────────────────────────────────────────────────────

  async latestLegal(c: Conn, kind: string): Promise<LegalRow | null> {
    const [row] = await c
      .select()
      .from(legal_text)
      .where(eq(legal_text.kind, kind))
      .orderBy(desc(legal_text.createdAt), desc(legal_text.id))
      .limit(1);
    return row ?? null;
  },

  async legalById(c: Conn, id: string | null): Promise<LegalRow | null> {
    if (!id) return null;
    const [row] = await c.select().from(legal_text).where(eq(legal_text.id, id)).limit(1);
    return row ?? null;
  },

  async insertLegal(c: Conn, row: typeof legal_text.$inferInsert): Promise<boolean> {
    const out = await c
      .insert(legal_text)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: legal_text.id });
    return out.length > 0;
  },

  async legalSources(c: Conn) {
    return c.select().from(legal_text_source);
  },

  async markLegalChecked(c: Conn, kind: string, url: string, at: Date, error: string | null) {
    await c
      .insert(legal_text_source)
      .values({ kind, url, checkedAt: at, lastError: error })
      .onConflictDoUpdate({
        target: legal_text_source.kind,
        set: { url, checkedAt: at, lastError: error },
      });
  },

  // ── the signed-in person's summary ────────────────────────────────────

  /**
   * One query, on the org_membership user and account_task org and status indexes: every
   * organisation with account content where the person holds one of `roles`, with task
   * counts (withdrawn tasks left out, locked ones in, and how many wait on them now) and
   * the oldest task waiting on them.
   */
  async tasksSummary(c: Conn, appUserId: string, roles: readonly string[]) {
    return (
      c
        .select({
          org_id: org.id,
          name: org.name,
          logo_url: org.logo_url,
          account_stage: org.account_stage,
          tasks_done: sql<number>`count(${task.id}) filter (where ${task.status} = 'done')::int`,
          tasks_total: sql<number>`count(${task.id}) filter (where ${task.status} <> 'withdrawn')::int`,
          tasks_waiting: sql<number>`count(${task.id}) filter (where ${task.status} in ('open', 'changes_requested'))::int`,
          // The oldest task waiting on the person: its title, or its code and params.
          next_task: sql<{
            title: string | null;
            code: string | null;
            params: unknown;
          } | null>`(select json_build_object('title', t2.title, 'code', t2.code, 'params', t2.params) from account_task t2
          where t2.org_id = ${org.id} and t2.status in ('open', 'changes_requested')
          order by t2.created_at, t2.id limit 1)`,
        })
        .from(org_membership)
        .innerJoin(org, eq(org.id, org_membership.org_id))
        .leftJoin(task, eq(task.orgId, org.id))
        .where(
          and(
            eq(org_membership.user_id, appUserId),
            isNull(org_membership.deleted_at),
            inArray(org_membership.role, [...roles]),
            isNull(org.deleted_at),
          ),
        )
        .groupBy(org.id)
        // Only organisations with account content: a stage, a task, or a document.
        .having(
          sql`${org.account_stage} is not null or count(${task.id}) > 0 or exists (select 1 from account_document d where d.org_id = ${org.id})`,
        )
        .orderBy(asc(org.name))
    );
  },

  // ── onboarding ────────────────────────────────────────────────────────

  /**
   * Marks the organisation's open tasks with `code` done, in one statement, so a trigger
   * that fires twice (or two at once) settles a task once. Returns the ids it settled.
   */
  async settleOpenByCode(c: Conn, orgId: string, code: string, now: Date) {
    return c
      .update(task)
      .set({ status: "done", nextReminderAt: null, updatedAt: now })
      .where(and(eq(task.orgId, orgId), eq(task.code, code), inArray(task.status, [...OPEN])))
      .returning({ id: task.id, orgId: task.orgId });
  },

  /**
   * Whether the organisation owning `projectId` has an open "Check out the demo" step for
   * that project. A read on the account_task org and status index, so a project load in an
   * organisation without one costs no write.
   */
  async demoStepOpen(c: Conn, projectId: string): Promise<boolean> {
    const rows = await c.execute<{ one: number }>(
      sql`select 1 as one from account_task t
        where t.org_id = (select w.org_id from project p join workspace w on w.id = p.workspace_id
          where p.id = ${projectId})
          and t.status in ('open', 'changes_requested') and t.code = 'explore_demo'
          and t.params->>'project_id' = ${projectId}
        limit 1`,
    );
    return rows.length > 0;
  },

  /**
   * "Check out the demo" for the demo project `projectId`, settled only when `appUserId`
   * is a member of that organisation: staff reviewing the draft are not, so their visit
   * does not count.
   */
  async settleDemoOpened(c: Conn, projectId: string, appUserId: string, now: Date) {
    return c
      .update(task)
      .set({ status: "done", nextReminderAt: null, updatedAt: now })
      .where(
        and(
          eq(task.code, "explore_demo"),
          inArray(task.status, [...OPEN]),
          sql`${task.params}->>'project_id' = ${projectId}`,
          sql`exists (select 1 from org_membership m where m.org_id = ${task.orgId}
            and m.user_id = ${appUserId} and m.deleted_at is null)`,
        ),
      )
      .returning({ id: task.id, orgId: task.orgId });
  },

  /**
   * "Create a project" in the organisation that owns `projectId`, unless the project is a
   * synthetic demo (its popcorn session says so): those projects are ours.
   */
  async settleProjectCreated(c: Conn, projectId: string, now: Date) {
    return c
      .update(task)
      .set({ status: "done", nextReminderAt: null, updatedAt: now })
      .where(
        and(
          eq(task.code, "create_project"),
          inArray(task.status, [...OPEN]),
          sql`${task.orgId} = (select w.org_id from project p join workspace w on w.id = p.workspace_id
            where p.id = ${projectId} and p.deleted_at is null and ${NOT_SYNTHETIC})`,
        ),
      )
      .returning({ id: task.id, orgId: task.orgId });
  },

  /** Withdraws the organisation's unfinished tasks with one of `codes`; returns their codes. */
  async withdrawUnfinished(c: Conn, orgId: string, codes: readonly string[], now: Date) {
    return c
      .update(task)
      .set({ status: "withdrawn", nextReminderAt: null, updatedAt: now })
      .where(
        and(
          eq(task.orgId, orgId),
          inArray(task.code, [...codes]),
          sql`${task.status} not in ('done', 'withdrawn')`,
        ),
      )
      .returning({ id: task.id, code: task.code });
  },

  /** The onboarding codes whose step the organisation already took before the tasks existed. */
  async onboardingAlreadyDone(c: Conn, orgId: string): Promise<string[]> {
    const [row] = await c.execute<{ project: boolean; booking: boolean }>(
      sql`select
        exists (select 1 from project p join workspace w on w.id = p.workspace_id
          where w.org_id = ${orgId} and p.deleted_at is null and ${NOT_SYNTHETIC}) as project,
        exists (select 1 from account_event e where e.org_id = ${orgId}
          and e.type = 'booking.recorded') as booking`,
    );
    return [...(row?.project ? ["create_project"] : []), ...(row?.booking ? ["book_call"] : [])];
  },

  /** The organisation's oldest live workspace: where a first project of its own goes. */
  async firstWorkspace(c: Conn, orgId: string): Promise<string | null> {
    const [row] = await c
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(eq(workspace.org_id, orgId), isNull(workspace.deleted_at)))
      .orderBy(asc(workspace.created_at), asc(workspace.id))
      .limit(1);
    return row?.id ?? null;
  },

  /** The project of the organisation's synthetic demo, from the demo echo built for it. */
  async demoProject(
    c: Conn,
    orgId: string,
  ): Promise<{ projectId: string; workspaceId: string } | null> {
    const [row] = await c.execute<{ project_id: string | null; workspace_id: string | null }>(
      sql`select seed->'projects'->0->>'project_id' as project_id, seed->>'workspace_id' as workspace_id
        from account_demo where org_id = ${orgId} and seed is not null
        order by created_at desc limit 1`,
    );
    return row?.project_id && row.workspace_id
      ? { projectId: row.project_id, workspaceId: row.workspace_id }
      : null;
  },

  // ── staff list ────────────────────────────────────────────────────────

  /**
   * Every live organisation with what needs attention, newest first, bounded. `stage`
   * narrows to one stage (`none`: not an account yet); `q` matches the name or a member's
   * email address.
   */
  async accountList(
    c: Conn,
    opts: { stage: string | null; q: string | null; limit: number; offset: number },
  ) {
    const like = opts.q ? `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    return c
      .select({
        id: org.id,
        name: org.name,
        stage: org.account_stage,
        created_at: org.created_at,
        open_tasks: sql<number>`(select count(*)::int from account_task t where t.org_id = ${org.id} and t.status in ('open', 'changes_requested'))`,
        waiting_on_us: sql<number>`(select count(*)::int from account_task t where t.org_id = ${org.id} and t.status = 'submitted')`,
        unsigned_documents: sql<number>`(select count(*)::int from account_document d where d.org_id = ${org.id} and d.requires_signature and d.status in ('sent', 'viewed'))`,
        overdue_invoices: sql<number>`(select count(*)::int from account_document d where d.org_id = ${org.id} and d.kind = 'invoice' and (d.invoice_status = 'overdue' or (d.invoice_status = 'open' and d.due_on < current_date)))`,
        open_tickets: sql<number>`(select count(*)::int from account_ticket k where k.org_id = ${org.id} and k.status <> 'closed')`,
      })
      .from(org)
      .where(
        and(
          isNull(org.deleted_at),
          opts.stage === "none"
            ? isNull(org.account_stage)
            : opts.stage
              ? eq(org.account_stage, opts.stage)
              : undefined,
          like
            ? or(
                sql`${org.name} ilike ${like}`,
                sql`exists (select 1 from org_membership m join app_user u on u.id = m.user_id
                  left join auth_user a on a.id = u.directus_user_id
                  where m.org_id = ${org.id} and m.deleted_at is null
                  and (u.email ilike ${like} or a.email ilike ${like}))`,
              )
            : undefined,
        ),
      )
      .orderBy(desc(org.created_at), desc(org.id))
      .limit(opts.limit)
      .offset(opts.offset);
  },
};
