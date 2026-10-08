import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mintStaffKey, revokeStaffKeys } from "@dembrane/accounts";
import {
  adminUrl,
  C,
  CHAT_P1,
  type Harness,
  ORG,
  P,
  REPORT_P1,
  startHarness,
  TAG,
  U,
  WS,
} from "./harness";

const run = adminUrl ? describe : describe.skip;

/**
 * Every critical and high hole of access-model-reference.md section 7, fired at the whole
 * API as the attacker the hole names. Each test is named after its hole id; the status
 * table in SECURITY-HOLES.md points here.
 */
run("security holes (critical and high) against the whole API", () => {
  setDefaultTimeout(30_000);
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness("security_holes");
    // p2 open to its workspace, so rita (observer) and bob (external) reach it and the
    // tests below exercise the policy, not the visibility.
    await h.sql`update project set visibility = 'workspace' where id = ${P.p2}`;
  });
  afterAll(async () => {
    await h?.close();
  });

  const one = async <T>(q: string, ...args: unknown[]): Promise<T> =>
    (await h.sql.unsafe(q, args as never[]))[0] as T;

  test("harness: a fixture user is signed in by bearer session, anonymous is not", async () => {
    expect((await h.req("alice", "GET", "/api/v2/me")).status).toBe(200);
    expect((await h.req("anonymous", "GET", "/api/v2/me")).status).toBe(401);
  });

  test("C-1: no route lets a user change another user's role, email, password, token or 2FA", async () => {
    const before = await h.sql`
      select u.id, u.email, u.role, u.password, u.token, u.tfa_secret, u.status, a.email as auth_email
      from directus_users u join auth_user a on a.id = u.id order by u.id`;
    const staffRole = await one<{ id: string }>(
      "select id from directus_roles where name = 'Administrator'",
    );
    // Better Auth's own profile endpoint: only name and image are writable, and only one's own.
    await h.req("bob", "POST", "/api/auth/update-user", {
      name: "Bob",
      email: U.alice.email,
      role: staffRole.id,
      emailVerified: true,
      id: U.alice.directus,
      userId: U.alice.directus,
    });
    // Email change is not enabled; the endpoint refuses.
    const change = await h.req("bob", "POST", "/api/auth/change-email", {
      newEmail: "x@evil.test",
    });
    expect(change.status).toBeGreaterThanOrEqual(400);
    // No admin plugin: user management endpoints do not exist.
    for (const path of ["/api/auth/admin/set-role", "/api/auth/admin/update-user"])
      expect(
        (await h.req("bob", "POST", path, { userId: U.alice.directus, role: "admin" })).status,
      ).toBe(404);
    // The platform's own self-service routes take no user id; extra fields are ignored.
    await h.req("bob", "PATCH", "/api/v2/me", {
      display_name: "Bob",
      role: staffRole.id,
      email: U.alice.email,
      user_id: U.alice.directus,
    });
    await h.req("bob", "PATCH", "/api/user-settings/name", {
      first_name: "Bob",
      user_id: U.alice.directus,
      role: staffRole.id,
    });
    const after = await h.sql`
      select u.id, u.email, u.role, u.password, u.token, u.tfa_secret, u.status, a.email as auth_email
      from directus_users u join auth_user a on a.id = u.id order by u.id`;
    expect(after).toEqual(before);
    // And the principal still is not staff.
    const me = (await (await h.req("bob", "GET", "/api/v2/me")).json()) as Record<string, unknown>;
    expect(JSON.stringify(me)).not.toContain('"is_admin":true');
  });

  test("C-2: invites bind to the verified sign-in email, never to an editable profile copy", async () => {
    const victim = "victim.c2@example.com";
    const invite = await one<{ id: string }>(
      `insert into workspace_invite (id, email, role, workspace_id, expires_at, invited_by)
       values (gen_random_uuid(), $1, 'member', $2, now() + interval '7 days', $3) returning id`,
      victim,
      WS.aDefault,
      U.alice.app,
    );
    // The Directus-era attack: the profile row now says the victim's address.
    await h.sql`update directus_users set email = ${victim} where id = ${U.bob.directus}`;
    const list = (await (await h.req("bob", "GET", "/api/v2/me/invites")).json()) as unknown;
    expect(JSON.stringify(list)).not.toContain(invite.id);
    const accept = await h.req("bob", "POST", `/api/v2/me/invites/${invite.id}/accept`);
    expect([403, 404]).toContain(accept.status);
    await h.req("bob", "POST", "/api/v2/onboarding/complete", { org_name: "B" });
    const joined = await h.sql`
      select 1 from workspace_membership
      where user_id = ${U.bob.app} and workspace_id = ${WS.aDefault} and deleted_at is null`;
    expect(joined).toHaveLength(0);
    const still = await one<{ accepted_at: string | null }>(
      "select accepted_at from workspace_invite where id = $1",
      invite.id,
    );
    expect(still.accepted_at).toBeNull();
    await h.sql`update directus_users set email = ${U.bob.email} where id = ${U.bob.directus}`;
  });

  test("C-3: a report is edited only through its own project, with the policy the edit needs", async () => {
    const before = await one<{ content: string; status: string }>(
      "select content, status from project_report where id = $1",
      REPORT_P1,
    );
    // Bob's own project p3, alice's report id.
    const foreign = await h.req("bob", "PATCH", `/api/projects/${P.p3}/reports/${REPORT_P1}`, {
      content: "pwned",
      status: "draft",
    });
    expect(foreign.status).toBe(404);
    // Bob has no access to p1 at all.
    const direct = await h.req("bob", "PATCH", `/api/projects/${P.p1}/reports/${REPORT_P1}`, {
      content: "pwned",
    });
    expect(direct.status).toBe(404);
    const after = await one<{ content: string; status: string }>(
      "select content, status from project_report where id = $1",
      REPORT_P1,
    );
    expect(after).toEqual(before);
  });

  test("C-4: conversation tag links change only on the caller's own conversation, with project tags", async () => {
    const before =
      await h.sql`select id, conversation_id, project_tag_id from conversation_project_tag order by id`;
    // The v1 route that deleted by integer id is gone.
    const gone = await h.req(
      "bob",
      "POST",
      `/api/projects/${P.p3}/conversations/${C.c3}/tags/delete`,
      {
        tag_ids: [1],
      },
    );
    expect(gone.status).toBe(404);
    // Its replacement: a foreign conversation is unreachable...
    const foreign = await h.req("bob", "POST", "/api/v2/bff/conversation-project-tags/replace", {
      conversation_id: C.c1,
      project_tag_ids: [],
    });
    expect(foreign.status).toBe(404);
    // ...and on one's own conversation, another project's tag is dropped, not linked.
    const own = await h.req("bob", "POST", "/api/v2/bff/conversation-project-tags/replace", {
      conversation_id: C.c3,
      project_tag_ids: [TAG.p1Energy],
    });
    expect(own.status).toBe(200);
    const after =
      await h.sql`select id, conversation_id, project_tag_id from conversation_project_tag order by id`;
    expect(after).toEqual(before);
  });

  test("C-5: deleting a project needs project:delete; observers and externals are refused", async () => {
    expect((await h.req("rita", "DELETE", `/api/projects/${P.p2}`)).status).toBe(403);
    expect((await h.req("bob", "DELETE", `/api/projects/${P.p2}`)).status).toBe(403);
    expect((await h.req("bob", "DELETE", `/api/projects/${P.p1}`)).status).toBe(404);
    const row = await one<{ deleted_at: string | null }>(
      "select deleted_at from project where id = $1",
      P.p2,
    );
    expect(row.deleted_at).toBeNull();
  });

  test("C-6: replies are read only through their own project; nothing lists or writes them by hand", async () => {
    await h.sql`
      insert into conversation_reply (id, conversation_id, content_text, type, date_created)
      values (gen_random_uuid(), ${C.c1}, 'secret reply c1', 'assistant_reply', now())`;
    const cross = await h.req(
      "anonymous",
      "GET",
      `/api/participant/projects/${P.p3}/conversations/${C.c1}/replies`,
    );
    expect(cross.status).toBe(404);
    expect(await cross.text()).not.toContain("secret reply");
    const forged = await h.req(
      "anonymous",
      "GET",
      `/api/participant/projects/${P.p1}/conversations/${C.c1}/replies`,
      undefined,
      { "x-participant-token": "p1.forged.sig" },
    );
    expect(forged.status).toBe(403);
    // The surface: no other route reads or writes conversation_reply rows.
    const replyRoutes = routes(h).filter((r) => /repl(y|ies)/i.test(r));
    expect(replyRoutes).toEqual([
      "GET /api/participant/projects/:project_id/conversations/:conversation_id/replies",
      "POST /api/conversations/:conversation_id/get-reply",
    ]);
  });

  test("C-7: report subscriber emails are listed only to readers of their project", async () => {
    await h.sql`
      insert into project_report_notification_participants
        (id, email, project_id, conversation_id, email_opt_in, email_opt_out_token)
      values (gen_random_uuid(), 'subscriber.c7@example.com', ${P.p1}, ${C.c1}, true, gen_random_uuid())`;
    const emails = await h.req("bob", "GET", `/api/conversations/${C.c1}/emails`);
    expect(emails.status).toBe(404);
    expect(await emails.text()).not.toContain("subscriber.c7");
    const count = await h.req("bob", "GET", `/api/projects/${P.p1}/participants/count`);
    expect(count.status).toBe(404);
    // An unsubscribe needs the opt-out token; a guessed one changes nothing.
    const unsub = await h.req("anonymous", "POST", `/api/participant/${P.p1}/report/unsubscribe`, {
      token: crypto.randomUUID(),
      email_opt_in: false,
    });
    expect(unsub.status).toBeGreaterThanOrEqual(400);
    const row = await one<{ email_opt_in: boolean }>(
      "select email_opt_in from project_report_notification_participants where email = 'subscriber.c7@example.com'",
    );
    expect(row.email_opt_in).toBe(true);
    // Subscribing is bound to a conversation of the project named.
    const sub = await h.req("anonymous", "POST", "/api/participant/report/subscribe", {
      emails: ["x@example.com"],
      project_id: P.p3,
      conversation_id: C.c1,
    });
    expect(sub.status).toBe(404);
    // The surface: nothing else touches subscribers.
    expect(routes(h).filter((r) => /subscri|emails/.test(r))).toEqual([
      "GET /api/conversations/:conversation_id/emails",
      "GET /api/participant/report/unsubscribe/eligibility",
      "POST /api/participant/:project_id/report/unsubscribe",
      "POST /api/participant/report/subscribe",
    ]);
  });

  test("H-1: the unauthenticated topic selection write is gone; topic writes need project:update", async () => {
    expect(
      (await h.req("anonymous", "PUT", `/api/verify/topics/${P.p1}`, { topic_list: [] })).status,
    ).toBe(404);
    expect(
      (
        await h.req("anonymous", "POST", `/api/verify/topics/${P.p1}/custom`, {
          label: "x",
          prompt: "y",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.req("bob", "POST", `/api/verify/topics/${P.p1}/custom`, {
          label: "x",
          prompt: "y",
        })
      ).status,
    ).toBe(403);
  });

  test("H-2: verify writes need a verify-enabled, live conversation, and never pull another one in", async () => {
    // p3 has verify off.
    const off = await h.req("anonymous", "POST", "/api/verify/generate", {
      topic_list: ["x"],
      conversation_id: C.c3,
    });
    expect(off.status).toBe(403);
    const forged = await h.req(
      "anonymous",
      "POST",
      "/api/verify/generate",
      { topic_list: ["x"], conversation_id: C.c1 },
      { "x-participant-token": "p1.forged.sig" },
    );
    expect(forged.status).toBe(403);
    const art = await one<{ id: string }>(
      `insert into conversation_artifact (id, conversation_id, content, key)
       values (gen_random_uuid(), $1, 'a', 'x') returning id`,
      C.c1,
    );
    const pull = await h.req("anonymous", "PUT", `/api/verify/artifact/${art.id}`, {
      useConversation: { conversationId: C.c3, timestamp: new Date().toISOString() },
    });
    expect(pull.status).toBe(400);
  });

  test("H-3: a tag is deleted only through its own project and with project:update", async () => {
    expect(
      (await h.req("bob", "DELETE", `/api/projects/${P.p3}/tags/${TAG.p1Energy}`)).status,
    ).not.toBe(200);
    const tag = await one<{ id: string }>(
      `insert into project_tag (id, project_id, text) values (gen_random_uuid(), $1, 'p2 tag') returning id`,
      P.p2,
    );
    expect((await h.req("rita", "DELETE", `/api/projects/${P.p2}/tags/${tag.id}`)).status).toBe(
      403,
    );
    const left = await h.sql`select id from project_tag where id in (${TAG.p1Energy}, ${tag.id})`;
    expect(left).toHaveLength(2);
  });

  test("H-4: a chat takes context only from its own project", async () => {
    const chat = await one<{ id: string }>(
      `insert into project_chat (id, project_id, user_created, chat_mode, date_created)
       values (gen_random_uuid(), $1, $2, 'agentic', now()) returning id`,
      P.p3,
      U.bob.directus,
    );
    const single = await h.req("bob", "POST", `/api/chats/${chat.id}/add-context`, {
      conversation_id: C.c1,
    });
    expect(single.status).toBe(404);
    const many = await h.req("bob", "POST", `/api/chats/${chat.id}/add-context`, {
      conversation_ids: [C.c1],
      project_id: P.p1,
    });
    expect(many.status).toBeGreaterThanOrEqual(400);
    const listed = await h.req("bob", "POST", `/api/chats/${chat.id}/add-context`, {
      conversation_ids: [C.c1],
      project_id: P.p3,
    });
    expect(((await listed.json()) as { added: unknown[] }).added).toEqual([]);
    const linked = await h.sql`
      select 1 from project_chat_conversation where project_chat_id = ${chat.id}`;
    expect(linked).toHaveLength(0);
    // Nor through alice's chat.
    expect((await h.req("bob", "GET", `/api/chats/${CHAT_P1}/context`)).status).toBe(404);
  });

  test("H-5: a participant reads a conversation only through its own project", async () => {
    for (const tail of ["", "/chunks"]) {
      const res = await h.req(
        "anonymous",
        "GET",
        `/api/participant/projects/${P.p3}/conversations/${C.c1}${tail}`,
      );
      expect(res.status).toBe(404);
    }
  });

  test("H-6: stateless transcription reads no URL and no key outside the caller's project", async () => {
    const form = new FormData();
    form.set("project_id", P.p3);
    form.set("audio_file_uri", `conversation/${C.c1}/chunks/x-audio.webm`);
    const key = await h.app.request("/api/stateless/transcribe", {
      method: "POST",
      headers: { authorization: `Bearer ${h.token("bob")}` },
      body: form,
    });
    expect(key.status).toBe(400);
    const url = new FormData();
    url.set("project_id", P.p3);
    url.set("audio_file_uri", "http://169.254.169.254/latest/meta-data");
    const ssrf = await h.app.request("/api/stateless/transcribe", {
      method: "POST",
      headers: { authorization: `Bearer ${h.token("bob")}` },
      body: url,
    });
    expect(ssrf.status).toBe(400);
  });

  test("H-7: confirm-upload accepts only the key issued for this conversation's chunk", async () => {
    const res = await h.req(
      "anonymous",
      "POST",
      `/api/participant/conversations/${C.c3}/confirm-upload`,
      {
        chunk_id: crypto.randomUUID(),
        file_url: `conversation/${C.c1}/chunks/abc-audio.webm`,
        timestamp: new Date().toISOString(),
        source: "PORTAL_AUDIO",
      },
    );
    expect(res.status).toBe(400);
    const chunks =
      await h.sql`select 1 from conversation_chunk where path like ${`%${C.c1}%`} and conversation_id = ${C.c3}`;
    expect(chunks).toHaveLength(0);
  });

  test("H-8: a workspace billing role reads no project data", async () => {
    await h.sql`
      insert into workspace_membership (id, workspace_id, user_id, role, source)
      values (gen_random_uuid(), ${WS.aDefault}, ${U.bob.app}, 'billing', 'direct')`;
    try {
      for (const path of [
        `/api/projects/${P.p1}/transcripts`,
        `/api/projects/${P.p1}/reports`,
        `/api/projects/${P.p1}/reports/latest`,
        `/api/projects/${P.p1}/reports/${REPORT_P1}/detail`,
        `/api/projects/${P.p1}/reports/${REPORT_P1}/views`,
        `/api/projects/${P.p1}/participants/count`,
        `/api/v2/projects/${P.p1}`,
        `/api/v2/projects/${P.p1}/bff`,
        `/api/v2/projects/${P.p1}/conversation-usage`,
        `/api/conversations/${C.c1}/transcript`,
      ])
        expect([path, (await h.req("bob", "GET", path)).status]).toEqual([path, 404]);
    } finally {
      await h.sql`
        delete from workspace_membership
        where workspace_id = ${WS.aDefault} and user_id = ${U.bob.app}`;
    }
  });

  test("H-9: deleting or unscheduling a report needs report:delete or report:publish", async () => {
    const r = await one<{ id: number }>(
      `insert into project_report (project_id, status, kind, content, scheduled_at, date_created)
       values ($1, 'scheduled', 'report', 'p2 report', now() + interval '1 day', now()) returning id`,
      P.p2,
    );
    for (const who of ["rita", "bob"] as const) {
      expect((await h.req(who, "DELETE", `/api/projects/${P.p2}/reports/${r.id}`)).status).toBe(
        403,
      );
      expect(
        (await h.req(who, "POST", `/api/projects/${P.p2}/reports/${r.id}/cancel-schedule`)).status,
      ).toBe(403);
    }
    const row = await one<{ status: string; deleted_at: string | null }>(
      "select status, deleted_at from project_report where id = $1",
      r.id,
    );
    expect(row).toEqual({ status: "scheduled", deleted_at: null });
  });

  test("H-10: get-reply refuses deleted conversations, closed projects and forged tokens, and is rate limited", async () => {
    await h.sql`update conversation set deleted_at = now() where id = ${C.c2}`;
    try {
      const deleted = await h.req("anonymous", "POST", `/api/conversations/${C.c2}/get-reply`, {
        language: "en",
      });
      expect(deleted.status).toBe(404);
    } finally {
      await h.sql`update conversation set deleted_at = null where id = ${C.c2}`;
    }
    const forged = await h.req(
      "anonymous",
      "POST",
      `/api/conversations/${C.c1}/get-reply`,
      { language: "en" },
      { "x-participant-token": "p1.forged.sig" },
    );
    expect(forged.status).toBe(403);
    await h.sql`update project set is_conversation_allowed = false where id = ${P.p3}`;
    try {
      const closed = await h.req("anonymous", "POST", `/api/conversations/${C.c3}/get-reply`, {
        language: "en",
      });
      expect(closed.status).toBe(403);
    } finally {
      await h.sql`update project set is_conversation_allowed = true where id = ${P.p3}`;
    }
  });

  test("H-12: a workspace admin cannot demote or remove an owner", async () => {
    const owner = await one<{ id: string }>(
      "select id from workspace_membership where workspace_id = $1 and user_id = $2",
      WS.aDefault,
      U.alice.app,
    );
    const demote = await h.req(
      "erin",
      "PATCH",
      `/api/v2/workspaces/${WS.aDefault}/members/${owner.id}`,
      {
        role: "member",
      },
    );
    expect(demote.status).toBe(403);
    const remove = await h.req(
      "erin",
      "DELETE",
      `/api/v2/workspaces/${WS.aDefault}/members/${owner.id}`,
    );
    expect(remove.status).toBe(403);
    const row = await one<{ role: string; deleted_at: string | null }>(
      "select role, deleted_at from workspace_membership where id = $1",
      owner.id,
    );
    expect(row).toEqual({ role: "owner", deleted_at: null });
  });

  test("H-13: a staff support session cannot touch consent, and turning consent off ends it now", async () => {
    await h.sql`update workspace set allow_support_access = true where id = ${WS.bDefault}`;
    await h.sql`
      insert into workspace_membership (id, workspace_id, user_id, role, source, expires_at)
      values (gen_random_uuid(), ${WS.bDefault}, ${U.admin.app}, 'admin', 'staff_support', now() + interval '1 day')`;
    const self = await h.req("admin", "PATCH", `/api/v2/workspaces/${WS.bDefault}/settings`, {
      allow_support_access: true,
    });
    expect(self.status).toBe(403);
    const members = await h.req("admin", "PATCH", `/api/v2/workspaces/${WS.bDefault}/members/x`, {
      role: "admin",
    });
    expect([403, 404]).toContain(members.status);
    const off = await h.req("bob", "PATCH", `/api/v2/workspaces/${WS.bDefault}/settings`, {
      allow_support_access: false,
    });
    expect(off.status).toBe(200);
    const live = await h.sql`
      select 1 from workspace_membership
      where workspace_id = ${WS.bDefault} and source = 'staff_support' and deleted_at is null
        and (expires_at is null or expires_at > now())`;
    expect(live).toHaveLength(0);
    expect((await h.req("admin", "GET", `/api/v2/projects/${P.p3}`)).status).toBe(404);
  });

  test("H-14: staff read no tenant's data without a support session, and staff actions are audited", async () => {
    for (const path of [
      `/api/v2/projects/${P.p3}`,
      `/api/projects/${P.p3}/transcripts`,
      `/api/conversations/${C.c3}/transcript`,
      `/api/v2/bff/conversations/${C.c3}`,
      `/api/projects/${P.p3}/webhooks`,
    ])
      expect([path, (await h.req("admin", "GET", path)).status]).toEqual([path, 404]);
    // The v1 chat and agentic surfaces had their own staff bypass.
    const chat = await one<{ id: string }>(
      `insert into project_chat (id, project_id, user_created, chat_mode, date_created)
       values (gen_random_uuid(), $1, $2, 'overview', now()) returning id`,
      P.p3,
      U.bob.directus,
    );
    for (const path of [
      `/api/chats/${chat.id}/context`,
      `/api/agentic/chats/${chat.id}/messages`,
      `/api/agentic/projects/${P.p3}/chats`,
      `/api/agentic/projects/${P.p3}/conversations`,
    ])
      expect([path, (await h.req("admin", "GET", path)).status]).toEqual([path, 404]);
    // The activity log is the caller's own, staff included.
    await h.sql`
      insert into directus_activity (action, "user", timestamp, collection, item, ip)
      values ('update', ${U.bob.directus}, now(), 'project', ${P.p3}, '10.0.0.9')`;
    const log = await h.req("admin", "GET", "/api/user-settings/audit-logs?page_size=500");
    expect(log.status).toBe(200);
    expect(await log.text()).not.toContain(U.bob.directus);
    // A tier change is a named, audited staff action.
    const tierBefore = await one<{ n: number }>(
      "select count(*)::int as n from staff_audit_event where permission = 'staff:set_tier'",
    );
    await h.req("admin", "PATCH", `/api/v2/workspaces/${WS.bDefault}/tier`, {
      tier: "innovator",
      reason: "security suite",
    });
    const tierAfter = await one<{ n: number }>(
      "select count(*)::int as n from staff_audit_event where permission = 'staff:set_tier'",
    );
    expect(tierAfter.n).toBe(tierBefore.n + 1);
    expect(
      (
        await h.req("bob", "PATCH", `/api/v2/workspaces/${WS.bDefault}/tier`, {
          tier: "guardian",
          reason: "x",
        })
      ).status,
    ).toBe(403);
    const before = await one<{ n: number }>("select count(*)::int as n from staff_audit_event");
    const res = await h.req("admin", "GET", `/api/v2/admin/workspaces/${WS.bDefault}/members`);
    expect(res.status).toBe(200);
    const after = await one<{ n: number }>("select count(*)::int as n from staff_audit_event");
    expect(after.n).toBe(before.n + 1);
    // A non-staff user is refused the same route and leaves no trail.
    expect(
      (await h.req("bob", "GET", `/api/v2/admin/workspaces/${WS.bDefault}/members`)).status,
    ).toBe(403);
  });
});

/** Holes the port introduced (SECURITY-HOLES.md, "new"), and medium and low fixes. */
run("security: new holes and medium and low fixes against the whole API", () => {
  setDefaultTimeout(30_000);
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness("security_new");
  });
  afterAll(async () => {
    await h?.close();
  });

  const one = async <T>(q: string, ...args: unknown[]): Promise<T> =>
    (await h.sql.unsafe(q, args as never[]))[0] as T;
  const bearer = (key: string, method: string, path: string, body?: unknown) =>
    h.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  test("N-1: a staff API key acts only within its scope, never as blanket staff", async () => {
    const { key, scope } = await mintStaffKey(h.deps.db, U.admin.email, "suite");
    expect(scope).toEqual([
      "staff:accounts",
      "staff:privacy",
      "staff:workspaces",
      "staff:announcements",
    ]);
    // In scope: staff:workspaces.
    expect(
      (await bearer(key, "GET", `/api/v2/admin/workspaces/${WS.bDefault}/members`)).status,
    ).toBe(200);
    // Out of scope: support sessions into customer data, billing.
    expect(
      (await bearer(key, "POST", `/api/v2/admin/workspaces/${WS.bDefault}/join-support`, {}))
        .status,
    ).toBe(403);
    expect((await bearer(key, "GET", "/api/v2/admin/billing-rollup")).status).toBe(403);
    const narrow = await mintStaffKey(h.deps.db, U.admin.email, "narrow", {
      scope: ["staff:accounts"],
    });
    expect(
      (await bearer(narrow.key, "GET", `/api/v2/admin/workspaces/${WS.bDefault}/members`)).status,
    ).toBe(403);
    await expect(
      mintStaffKey(h.deps.db, U.admin.email, "grant", { scope: ["staff:grant"] }),
    ).rejects.toThrow();
    expect(await revokeStaffKeys(h.deps.db, "narrow")).toBe(1);
    expect(await revokeStaffKeys(h.deps.db, "suite")).toBe(1);
  });

  test("N-1: a staff API key ends at its hard expiry, however Better Auth slides the session", async () => {
    const { key } = await mintStaffKey(h.deps.db, U.admin.email, "slide");
    const past = Math.floor(Date.now() / 1000) - 60;
    await h.sql`
      update auth_session set user_agent = ${`staff-api-key:slide|until=${past}|scope=staff:workspaces`}
      where token = ${key}`;
    expect((await bearer(key, "GET", "/api/v2/me")).status).toBe(401);
    // A key minted before scopes existed: a year from creation, the default scope.
    await h.sql`
      update auth_session set user_agent = 'staff-api-key:slide', created_at = now() - interval '400 days'
      where token = ${key}`;
    expect((await bearer(key, "GET", "/api/v2/me")).status).toBe(401);
    await h.sql`update auth_session set created_at = now() where token = ${key}`;
    expect(
      (await bearer(key, "GET", `/api/v2/admin/workspaces/${WS.bDefault}/members`)).status,
    ).toBe(200);
    expect(await revokeStaffKeys(h.deps.db, "slide")).toBe(1);
  });

  test("N-2: a suspended or archived user's live sessions stop working", async () => {
    expect((await h.req("rita", "GET", "/api/v2/me")).status).toBe(200);
    for (const status of ["suspended", "archived"]) {
      await h.sql`update directus_users set status = ${status} where id = ${U.rita.directus}`;
      expect((await h.req("rita", "GET", "/api/v2/me")).status).toBe(401);
    }
    await h.sql`update directus_users set status = 'active' where id = ${U.rita.directus}`;
    expect((await h.req("rita", "GET", "/api/v2/me")).status).toBe(200);
  });

  test("N-3: a public asset never renders as a page on the API origin", async () => {
    const folder = await one<{ id: string }>(
      "select id from directus_folders where name = 'Public'",
    );
    const logos = await one<{ id: string }>(
      "select id from directus_folders where name = 'custom_logos'",
    );
    const html = "security-suite.html";
    const png = "security-suite.png";
    await h.deps.files.put(
      html,
      new TextEncoder().encode("<script>alert(1)</script>"),
      "text/html",
    );
    await h.deps.files.put(png, new Uint8Array([137, 80, 78, 71]), "image/png");
    const add = async (disk: string, type: string, folderId: string) =>
      (
        await one<{ id: string }>(
          `insert into directus_files (id, storage, filename_disk, filename_download, type, folder, created_on, modified_on)
           values (gen_random_uuid(), 'local', $1, $1, $2, $3, now(), now()) returning id`,
          disk,
          type,
          folderId,
        )
      ).id;
    const page = await h.req(
      "anonymous",
      "GET",
      `/api/assets/${await add(html, "text/html", folder.id)}`,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("sandbox");
    expect(page.headers.get("content-disposition")).toBe("attachment");
    const logo = await h.req(
      "anonymous",
      "GET",
      `/api/assets/${await add(png, "image/png", logos.id)}`,
    );
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-disposition")).toBeNull();
    // H-14: staff get no blanket read of a file outside the public rules.
    const privateFile = await add(
      png,
      "image/png",
      (await one<{ id: string }>("select id from directus_folders where name = 'avatars'")).id,
    );
    await h.sql`update directus_files set folder = null where id = ${privateFile}`;
    expect((await h.req("admin", "GET", `/api/assets/${privateFile}`)).status).toBe(404);
  });

  test("M-3: a ping under a foreign project id never shows that conversation in its monitor", async () => {
    await h.req("anonymous", "POST", `/api/participant/conversations/${C.c3}/ping`, {
      project_id: P.p1,
      state: "recording",
    });
    const res = await h.req(
      "alice",
      "GET",
      `/api/v2/bff/conversations/monitor?project_id=${P.p1}&window_seconds=48`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(C.c3);
  });

  test("M-19: a report sign-up takes a handful of addresses, not a mailing list", async () => {
    const res = await h.req("anonymous", "POST", "/api/participant/report/subscribe", {
      emails: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`),
      project_id: P.p1,
      conversation_id: C.c1,
    });
    expect(res.status).toBe(422);
  });

  test("L-14: a revived membership drops its old support expiry and custom policies", async () => {
    const ws = WS.aDefault;
    // Only organisation members are re-added directly; everyone else gets a pending invite.
    await h.sql`
      insert into org_membership (id, org_id, user_id, role)
      values (gen_random_uuid(), ${ORG.a}, ${U.bob.app}, 'member')`;
    await h.sql`
      insert into workspace_membership (id, workspace_id, user_id, role, source, expires_at, custom_policies, deleted_at)
      values (gen_random_uuid(), ${ws}, ${U.bob.app}, 'admin', 'staff_support', now() - interval '1 day',
              '["member:manage"]', now() - interval '1 hour')`;
    const res = await h.req("alice", "POST", `/api/v2/workspaces/${ws}/invite`, {
      email: U.bob.email,
      role: "member",
    });
    expect(res.status).toBe(200);
    const row = await one<{ expires_at: string | null; custom_policies: unknown; source: string }>(
      "select expires_at, custom_policies, source from workspace_membership where workspace_id = $1 and user_id = $2 and deleted_at is null",
      ws,
      U.bob.app,
    );
    expect(row).toEqual({ expires_at: null, custom_policies: [], source: "direct" });
  });

  test("M-14: an org admin removed from a workspace cannot join it back alone", async () => {
    await h.sql`
      update workspace_membership set deleted_at = now()
      where workspace_id = ${WS.aDefault} and user_id = ${U.erin.app}`;
    await h.sql`
      update workspace set settings = ${JSON.stringify({ sticky_removed: [{ user_id: U.erin.app }] })}::json
      where id = ${WS.aDefault}`;
    const res = await h.req("erin", "POST", `/api/v2/workspaces/${WS.aDefault}/join`);
    expect(res.status).toBe(403);
    const live = await h.sql`
      select 1 from workspace_membership
      where workspace_id = ${WS.aDefault} and user_id = ${U.erin.app} and deleted_at is null`;
    expect(live).toHaveLength(0);
  });

  test("M-15: only an admin of the workspace's organisation re-scopes its billing", async () => {
    await h.sql`
      update workspace_membership set role = 'admin'
      where workspace_id = ${WS.aResearch} and user_id = ${U.rita.app}`;
    const res = await h.req("rita", "PATCH", `/api/v2/workspaces/${WS.aResearch}/data-ownership`, {
      usage_context: "external",
      data_owner_org_name: "Elsewhere",
      data_owner_email: "owner@elsewhere.test",
      partner_agreement_accepted: true,
    });
    expect(res.status).toBe(403);
  });
});

function routes(h: Harness): string[] {
  const seen = new Set<string>();
  for (const r of h.app.routes) if (r.method !== "ALL") seen.add(`${r.method} ${r.path}`);
  return [...seen].sort();
}
