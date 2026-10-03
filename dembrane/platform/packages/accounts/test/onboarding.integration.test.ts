import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import { and, eq } from "drizzle-orm";
import * as K from "../src/contract";
import { recordBooking, recordTutorialOpened } from "../src/customer";
import type { AccountsDeps } from "../src/deps";
import * as F from "../src/fixtures";
import {
  completeOnboarding,
  isOnboardingCode,
  type OnboardingSignals,
  onboardingSignals,
} from "../src/onboarding";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// The prospect's onboarding tasks: who adds them (the demo builder and staff, never a
// signup on its own), each step that completes one, that a step completes once, that a
// project load writes only for an open demo step, and that a completion that fails never
// fails the step itself.
const run = admin ? describe : describe.skip;
const DB = `accounts_onboarding_${process.pid}`;

run("onboarding tasks", () => {
  setDefaultTimeout(60_000);
  let w: World;
  let signals: OnboardingSignals;
  let workspaceId: string;
  let demoProject: string;
  /** Another synthetic project in the same workspace: opening it is not opening the demo. */
  let otherProject: string;
  let ownProject: string;
  const path = (orgId: string) => `/api/v2/admin/accounts/${orgId}/onboarding`;

  /** A workspace in `orgId`, with its billing account the schema asks for. */
  async function workspaceIn(orgId: string): Promise<string> {
    const billingId = newId();
    await w.db.insert(schema.billing_account).values({
      id: billingId,
      org_id: orgId,
      tier: "free",
      payment_mode: "none",
    });
    const id = newId();
    await w.db.insert(schema.workspace).values({
      id,
      org_id: orgId,
      name: "Werkruimte",
      billing_account_id: billingId,
      visibility: "open_to_organisation",
    });
    return id;
  }

  async function projectIn(ws: string, synthetic: boolean): Promise<string> {
    const id = newId();
    await w.db.insert(schema.project).values({
      id,
      workspace_id: ws,
      name: synthetic ? "[SYNTHETIC] demo" : "Eigen project",
      is_conversation_allowed: true,
    });
    if (synthetic)
      await w.db.insert(schema.agent_loop).values({
        id: newId(),
        project_id: id,
        expires_at: "2027-01-01T00:00:00Z",
        popcorn_state: { demo: { synthetic: true, language: "nl" } },
      });
    return id;
  }

  const statuses = async (orgId: string) =>
    Object.fromEntries(
      (await store.tasks(w.db, orgId))
        .filter((t) => isOnboardingCode(t.code))
        .map((t) => [t.code, t.status]),
    );
  const doneEvents = async (orgId: string) =>
    (await store.events(w.db, orgId, 200)).filter((e) => e.type === "task.done");

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    signals = onboardingSignals(w.deps);
    workspaceId = await workspaceIn(w.orgId);
    demoProject = await projectIn(workspaceId, true);
    otherProject = await projectIn(workspaceId, true);
    // The demo echo built for this organisation, as its seed step records it.
    await w.db.insert(schema.account_demo).values({
      id: newId(),
      orgId: w.orgId,
      status: "published",
      input: {},
      steps: {},
      seed: { workspace_id: workspaceId, projects: [{ language: "nl", project_id: demoProject }] },
      createdBy: w.people.staff.directusUserId,
    });
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("a signup on its own gets none: no tasks, nothing waiting, no Tasks entry", async () => {
    // A self-serve organisation: an admin, a workspace with a project, no account content.
    const orgId = newId();
    await w.db.insert(schema.org).values({ id: orgId, name: "Zelf Aangemeld" });
    await w.db.insert(schema.org_membership).values({
      id: newId(),
      org_id: orgId,
      user_id: w.people.signer.appUserId as string,
      role: "admin",
    });
    await projectIn(await workspaceIn(orgId), false);
    expect(await store.tasks(w.db, orgId)).toEqual([]);
    const summary = K.TasksSummary.parse(
      (await call(w, "GET", "/api/v2/account/tasks-summary", "signer")).data,
    );
    expect(summary).toEqual([]);
  });

  test("staff add them: staff only, idempotent, audited, no reminders, worded from codes", async () => {
    expect((await call(w, "POST", path(w.orgId), "admin")).status).toBe(403);
    expect((await call(w, "POST", path(newId()), "staff")).status).toBe(404);
    const first = K.OnboardingResponse.parse((await call(w, "POST", path(w.orgId), "staff")).data);
    expect(first.added).toEqual(["explore_demo", "watch_tutorial", "create_project", "book_call"]);
    expect(first.tasks.map((t) => [t.code, t.status, t.kind, t.title])).toEqual([
      ["explore_demo", "open", "generic", null],
      ["watch_tutorial", "open", "generic", null],
      ["create_project", "open", "generic", null],
      ["book_call", "open", "generic", null],
    ]);
    expect(first.tasks.every((t) => t.next_reminder_at === null)).toBe(true);
    expect(first.tasks[0]?.params).toEqual({ project_id: demoProject, workspace_id: workspaceId });
    expect(first.tasks[1]?.params).toEqual({});
    // The demo's own synthetic projects are not a project of their own.
    expect(first.tasks[2]?.params).toEqual({ workspace_id: workspaceId });
    // Twice adds nothing new.
    const second = K.OnboardingResponse.parse((await call(w, "POST", path(w.orgId), "staff")).data);
    expect(second.added).toEqual([]);
    expect(second.tasks.map((t) => t.id)).toEqual(first.tasks.map((t) => t.id));
    expect((await store.tasks(w.db, w.orgId)).length).toBe(4);
    const audit = await w.db.select().from(schema.staff_audit_event);
    expect(
      audit.filter(
        (a) => a.action === "accounts.onboarding.add" && a.permission === "staff:accounts",
      ).length,
    ).toBe(3);
    const events = (await store.events(w.db, w.orgId, 200)).filter(
      (e) => e.type === "onboarding.added",
    );
    expect(events.map((e) => e.detail)).toEqual([{ codes: first.added }]);
    // The reminders tick has nothing to send for them.
    expect(await store.dueReminders(w.db, new Date("2027-01-01T00:00:00Z"), 50)).toEqual([]);
    // The admin sees four waiting, and the oldest first.
    const [mine] = K.TasksSummary.parse(
      (await call(w, "GET", "/api/v2/account/tasks-summary", "admin")).data,
    );
    expect([mine?.tasks_waiting, mine?.tasks_total, mine?.next_task_code]).toEqual([
      4,
      4,
      "explore_demo",
    ]);
    // A reply is not how these are done.
    const reply = await call(
      w,
      "POST",
      `/api/v2/orgs/${w.orgId}/account/tasks/${first.tasks[2]?.id}/submit`,
      "admin",
      {
        response_text: "gedaan",
      },
    );
    expect(reply.status).toBe(409);
  });

  test("explore_demo: a member opening the demo project; staff reviewing it does not count", async () => {
    await signals.projectOpened(demoProject, w.people.staff.appUserId);
    await signals.projectOpened(otherProject, w.people.member.appUserId);
    await signals.projectOpened(demoProject, null);
    expect((await statuses(w.orgId)).explore_demo).toBe("open");
    // A project load reads first and writes only where the demo step is open for it.
    expect(await store.demoStepOpen(w.db, demoProject)).toBe(true);
    expect(await store.demoStepOpen(w.db, otherProject)).toBe(false);
    expect(await store.demoStepOpen(w.db, newId())).toBe(false);
    await signals.projectOpened(demoProject, w.people.member.appUserId);
    await signals.projectOpened(demoProject, w.people.admin.appUserId);
    expect((await statuses(w.orgId)).explore_demo).toBe("done");
    expect(await store.demoStepOpen(w.db, demoProject)).toBe(false);
    // Done once: one timeline line however often the project is opened.
    expect((await doneEvents(w.orgId)).map((e) => e.detail)).toEqual([{ code: "explore_demo" }]);
  });

  test("watch_tutorial: the tutorial link clicked from the task, by someone who runs the account", async () => {
    const route = `/api/v2/orgs/${w.orgId}/account/tutorial-opened`;
    expect((await call(w, "POST", route, "outsider")).status).toBe(404);
    expect((await statuses(w.orgId)).watch_tutorial).toBe("open");
    const r = await call(w, "POST", route, "admin");
    expect([r.status, r.data]).toEqual([200, { recorded: true }]);
    expect(K.TutorialOpenedResponse.parse(r.data)).toEqual({ recorded: true });
    // Twice is the same as once.
    expect((await call(w, "POST", route, "admin")).status).toBe(200);
    expect((await statuses(w.orgId)).watch_tutorial).toBe("done");
  });

  test("create_project: not a synthetic demo project, then a project of their own", async () => {
    await signals.projectCreated(otherProject);
    expect((await statuses(w.orgId)).create_project).toBe("open");
    ownProject = await projectIn(workspaceId, false);
    await signals.projectCreated(ownProject);
    await signals.projectCreated(ownProject);
    expect((await statuses(w.orgId)).create_project).toBe("done");
    // Another organisation's project settles nothing here, and nothing there.
    expect((await statuses(w.otherOrgId)).create_project).toBeUndefined();
  });

  test("book_call: a booking recorded through the account's booking route", async () => {
    const r = await call(w, "POST", `/api/v2/orgs/${w.orgId}/account/booking`, "admin", {
      uid: "cal-onboarding",
      start: "2026-10-02T10:00:00Z",
      status: "accepted",
    });
    expect(r.status).toBe(200);
    expect(await statuses(w.orgId)).toEqual({
      explore_demo: "done",
      watch_tutorial: "done",
      create_project: "done",
      book_call: "done",
    });
    // Everything done: nothing waits, so the Tasks entry and the popup have nothing to show.
    const [mine] = K.TasksSummary.parse(
      (await call(w, "GET", "/api/v2/account/tasks-summary", "admin")).data,
    );
    expect([mine?.tasks_waiting, mine?.tasks_done]).toEqual([0, 4]);
  });

  test("a step taken before the tasks existed is done when they are added", async () => {
    const orgId = newId();
    await w.db
      .insert(schema.org)
      .values({ id: orgId, name: "Al Begonnen", account_stage: "prospect" });
    const ws = await workspaceIn(orgId);
    await projectIn(ws, false);
    const out = K.OnboardingResponse.parse((await call(w, "POST", path(orgId), "staff")).data);
    // No demo of theirs: nothing to explore.
    expect(out.added).toEqual(["watch_tutorial", "create_project", "book_call"]);
    expect(await statuses(orgId)).toEqual({
      watch_tutorial: "open",
      create_project: "done",
      book_call: "open",
    });
  });

  test("sending an offer withdraws the steps not taken; the ones taken stay done", async () => {
    const orgId = newId();
    await w.db
      .insert(schema.org)
      .values({ id: orgId, name: "Offerte BV", account_stage: "prospect" });
    await call(w, "POST", path(orgId), "staff");
    await completeOnboarding(w.deps, orgId, "watch_tutorial");
    const sent = await call(w, "POST", `/api/v2/admin/accounts/${orgId}/offers`, "staff", {
      ...F.pushOfferRequest,
      reference: null,
      offer_name: "Offerte BV",
    });
    expect(sent.status).toBe(201);
    expect(await statuses(orgId)).toEqual({
      watch_tutorial: "done",
      create_project: "withdrawn",
      book_call: "withdrawn",
    });
    // What the prospect has left to do: the offer's tasks only.
    const open = (await store.tasks(w.db, orgId))
      .filter((t) => !["done", "withdrawn"].includes(t.status))
      .map((t) => `${t.code}:${t.status}`);
    expect(open.sort()).toEqual(["billing_details:locked", "sign_offer:open"]);
    const events = (await store.events(w.db, orgId, 200)).filter(
      (e) => e.type === "onboarding.withdrawn",
    );
    expect(events.map((e) => e.detail)).toEqual([{ codes: ["create_project", "book_call"] }]);
  });

  test("a completion that fails is logged and never fails the step that triggered it", async () => {
    const lines: string[] = [];
    const logger = createLogger(
      { service: "t", release: "r", env: "test", level: "warn" },
      new Writable({
        write: (chunk, _e, cb) => {
          lines.push(String(chunk));
          cb();
        },
      }),
    );
    const orgId = newId();
    await w.db
      .insert(schema.org)
      .values({ id: orgId, name: "Kapot BV", account_stage: "prospect" });
    await w.db.insert(schema.org_membership).values({
      id: newId(),
      org_id: orgId,
      user_id: w.people.billing.appUserId as string,
      role: "admin",
    });
    await call(w, "POST", path(orgId), "staff");
    // The booking's own transaction goes through; the completion after it does not.
    let transactions = 0;
    const db = new Proxy(w.db, {
      get(target, prop, receiver) {
        if (prop === "transaction")
          return (...args: Parameters<typeof target.transaction>) => {
            if (++transactions > 1) throw new Error("database went away");
            return target.transaction(...args);
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const broken: AccountsDeps = { ...w.deps, db, logger };
    expect(
      await recordBooking(broken, w.people.billing, orgId, {
        uid: "cal-broken",
        start: null,
        status: "accepted",
      }),
    ).toEqual({ recorded: true });
    const booked = await w.db
      .select()
      .from(schema.account_event)
      .where(
        and(
          eq(schema.account_event.orgId, orgId),
          eq(schema.account_event.type, "booking.recorded"),
        ),
      );
    expect(booked).toHaveLength(1);
    expect((await statuses(orgId)).book_call).toBe("open");
    // The tutorial link answers as recorded and the step stays open.
    expect(await recordTutorialOpened(broken, w.people.billing, orgId)).toEqual({
      recorded: true,
    });
    expect((await statuses(orgId)).watch_tutorial).toBe("open");
    // The signals the rest of the product calls resolve the same way.
    const failing = onboardingSignals(broken);
    await expect(failing.projectCreated(ownProject)).resolves.toBeUndefined();
    await expect(
      failing.projectOpened(demoProject, w.people.admin.appUserId),
    ).resolves.toBeUndefined();
    expect(lines.filter((l) => l.includes("accounts.onboarding_complete_failed")).length).toBe(3);
  });
});
