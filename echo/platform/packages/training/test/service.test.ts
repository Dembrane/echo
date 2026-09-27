import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { accountRow, MemoryBillingStore, Notifier } from "@echo/billing";
import { ForbiddenError } from "@echo/core";
import { MemoryMailer } from "@echo/mail";
import { createLogger } from "@echo/observability";
import {
  completeTraining,
  listTrainings,
  orgRoster,
  parseIso,
  pyIsoformat,
  requestTraining,
  revokeLicense,
  rosterTrainingMap,
  type TrainingDeps,
  updateLicense,
} from "../src";
import { MemoryTrainingStore } from "./memory";

const now = new Date("2026-09-27T12:00:00.000Z");
const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

function setup() {
  const store = new MemoryTrainingStore();
  const notes = new MemoryBillingStore();
  notes.accounts.set("acc", accountRow({ id: "acc" }));
  notes.orgs.set("org", "Org");
  const mailer = new MemoryMailer();
  store.orgs.set("org", { id: "org", name: "Org", deleted_at: null });
  store.users.set("owner", { id: "owner", display_name: "Zed Owner", email: "z@x.io" });
  store.users.set("member", { id: "member", display_name: "ann member", email: "a@x.io" });
  store.users.set("staff", { id: "staff", display_name: "Staff", email: "s@dembrane.com" });
  store.memberships.push(
    { id: "m1", org_id: "org", user_id: "owner", role: "owner" },
    { id: "m2", org_id: "org", user_id: "member", role: "member" },
  );
  store.staff = ["staff", "owner"];
  const d: TrainingDeps = {
    store,
    notifier: new Notifier(notes, logger),
    mailer,
    logger,
    dashboardUrl: "https://dash.test/",
    clock: () => now,
  };
  return { d, store, notes, mailer };
}

test("parseIso reads naive values as UTC and rejects junk", () => {
  expect(parseIso("2026-01-02")?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  expect(parseIso("2026-01-02T10:30:00")?.toISOString()).toBe("2026-01-02T10:30:00.000Z");
  expect(parseIso("2026-01-02T10:30:00+02:00")?.toISOString()).toBe("2026-01-02T08:30:00.000Z");
  expect(parseIso("2026-01-02 10:30:00+00")?.toISOString()).toBe("2026-01-02T10:30:00.000Z");
  expect(parseIso("yesterday")).toBeNull();
  expect(pyIsoformat(new Date("2026-01-02T00:00:00Z"))).toBe("2026-01-02T00:00:00+00:00");
});

test("roster prefers an active licence over a later lapsed one and flags expiring soon", () => {
  const m = rosterTrainingMap(
    ["u1", "u2", "u3"],
    [
      { app_user_id: "u1", status: "revoked", expires_at: "2027-06-01T00:00:00Z" },
      { app_user_id: "u1", status: "active", expires_at: "2026-10-10T00:00:00Z" },
      { app_user_id: "u2", status: "active", expires_at: "2026-01-01T00:00:00Z" },
    ],
    now,
  );
  expect(m.get("u1")).toEqual({
    trained: true,
    trained_until: "2026-10-10T00:00:00Z",
    expiring_soon: true,
  });
  expect(m.get("u2")?.trained).toBe(false);
  expect(m.get("u3")).toEqual({ trained: false, trained_until: null, expiring_soon: false });
});

test("members see only their own email; the list sorts by name", async () => {
  const { d } = setup();
  const r = await orgRoster(d, "org", "member");
  expect(r.can_manage).toBe(false);
  expect(r.members.map((m) => [m.display_name, m.email])).toEqual([
    ["ann member", "a@x.io"],
    ["Zed Owner", null],
  ]);
  await expect(orgRoster(d, "org", "stranger")).rejects.toBeInstanceOf(ForbiddenError);
});

test("a request prices extras, notifies staff except the requester, and emails the owner", async () => {
  const { d, store, notes, mailer } = setup();
  const out = await requestTraining(
    d,
    "org",
    { id: "owner" },
    {
      type: "online",
      extra_participants: 3,
      notes: null,
    },
  );
  expect(out).toMatchObject({ status: "requested", base_price_eur: 675, estimated_total_eur: 855 });
  expect(store.trainingsById.get(out.training_id)?.requested_by).toBe("owner");
  expect(notes.notifications.map((n) => n.audience_user_id)).toEqual(["staff"]);
  expect(notes.notifications[0]?.severity).toBe("action_required");
  expect(mailer.sent[0]?.to).toBe("pauline@dembrane.com");
  expect(mailer.sent[0]?.text).toContain("Estimated total: EUR 855");
  expect(mailer.sent[0]?.text).toContain("https://dash.test/admin/training");
  await expect(
    requestTraining(
      d,
      "org",
      { id: "member" },
      { type: "online", extra_participants: 0, notes: null },
    ),
  ).rejects.toThrow("Organisation admins or owners only");
});

test("completing writes one-year licences, notifies each user and completes the training", async () => {
  const { d, store, notes } = setup();
  const t = await requestTraining(
    d,
    "org",
    { id: "owner" },
    {
      type: "online",
      extra_participants: 0,
      notes: null,
    },
  );
  notes.notifications.length = 0;
  const res = await completeTraining(d, t.training_id, "staff", {
    app_user_ids: ["owner", "member"],
    completed_at: "2026-09-01",
  });
  expect(res.licenses_created).toBe(2);
  const lic = store.licenses.get(res.license_ids[0] as string);
  expect(lic).toMatchObject({
    completed_at: "2026-09-01T00:00:00+00:00",
    expires_at: "2027-09-01T00:00:00+00:00",
    status: "active",
    granted_by: "staff",
    org_id: "org",
  });
  expect(notes.notifications.map((n) => n.event_code)).toEqual([
    "TRAINING_COMPLETED",
    "TRAINING_COMPLETED",
  ]);
  expect(store.trainingsById.get(t.training_id)?.status).toBe("completed");

  const listed = await listTrainings(d, { orgId: "org" });
  expect(listed[0]).toMatchObject({ license_count: 2, org_member_count: 2, org_name: "Org" });
});

test("revoking the last active licence moves the training back to requested", async () => {
  const { d, store } = setup();
  const t = await requestTraining(
    d,
    "org",
    { id: "owner" },
    {
      type: "online",
      extra_participants: 0,
      notes: null,
    },
  );
  const res = await completeTraining(d, t.training_id, "staff", {
    app_user_ids: ["owner", "member"],
    completed_at: null,
  });
  await revokeLicense(d, res.license_ids[0] as string);
  expect(store.trainingsById.get(t.training_id)?.status).toBe("completed");
  await revokeLicense(d, res.license_ids[1] as string);
  expect(store.trainingsById.get(t.training_id)?.status).toBe("requested");
});

test("editing a licence recomputes expiry and refuses an empty edit", async () => {
  const { d } = setup();
  const t = await requestTraining(
    d,
    "org",
    { id: "owner" },
    {
      type: "online",
      extra_participants: 0,
      notes: null,
    },
  );
  const res = await completeTraining(d, t.training_id, "staff", {
    app_user_ids: ["member"],
    completed_at: null,
  });
  const id = res.license_ids[0] as string;
  const out = await updateLicense(d, id, { completed_at: "2026-03-01T00:00:00Z" });
  expect(out.expires_at).toBe("2027-03-01T00:00:00.000Z");
  await expect(updateLicense(d, id, {})).rejects.toThrow("Nothing to update");
  await expect(updateLicense(d, id, { completed_at: "nope" })).rejects.toThrow(
    "Invalid completed_at",
  );
});
