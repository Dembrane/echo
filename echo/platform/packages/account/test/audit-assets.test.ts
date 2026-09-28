import { expect, test } from "bun:test";
import type { Signed } from "@dembrane/http";
import { mayRead } from "../src/assets";
import { auditOptions, auditPage, auditScope, csv } from "../src/audit";
import type { AuditScope, AuditStorage } from "../src/audit-storage";

const me = "d0000000-0000-4000-8000-000000000002";
const user: Signed = { appUserId: "x", directusUserId: me, isStaff: false };
const staff: Signed = { ...user, isStaff: true };

test("audit scope: staff see everything, others the rows by or about themselves", () => {
  expect(auditScope(staff)).toEqual({ all: true });
  expect(auditScope(user)).toEqual({ all: false, userId: me });
});

test("csv filters drop blanks", () => {
  expect(csv("create, update,,")).toEqual(["create", "update"]);
  expect(csv(null)).toEqual([]);
});

function fakeStore(scopes: AuditScope[]): AuditStorage {
  return {
    async page(scope) {
      scopes.push(scope);
      return [
        {
          id: 7,
          action: "update",
          collection: "directus_users",
          item: me,
          timestamp: "2026-09-27 10:00:00+00",
          ip: "10.0.0.1",
          user_agent: "ua",
          userId: me,
          email: "a@example.com",
          first_name: "A",
          last_name: null,
        },
      ];
    },
    async total() {
      return 41;
    },
    async counts(_scope, column) {
      return column === "action"
        ? [
            { value: "create", count: 3 },
            { value: " ", count: 1 },
          ]
        : [{ value: "project", count: 2 }];
    },
    async deltas() {
      return [{ activity: 7, delta: { first_name: "A" } }];
    },
  };
}

test("audit page: the page the settings card renders, deltas for staff only", async () => {
  const scopes: AuditScope[] = [];
  const q = { page: 1, page_size: 20, sort: "desc" as const };
  const f = { actions: [], collections: [] };
  const mine = await auditPage(fakeStore(scopes), user, f, q);
  expect(mine.total).toBe(41);
  expect(mine.items[0]).toEqual({
    id: 7,
    action: "update",
    collection: "directus_users",
    item: me,
    timestamp: "2026-09-27T10:00:00.000Z",
    ip: "10.0.0.1",
    user_agent: "ua",
    user: { id: me, email: "a@example.com", first_name: "A", last_name: null },
    revisions: [],
  });
  const all = await auditPage(fakeStore(scopes), staff, f, q);
  expect(all.items[0]?.revisions).toEqual([{ delta: { first_name: "A" } }]);
  expect(scopes).toEqual([{ all: false, userId: me }, { all: true }]);
});

test("audit options skip blank values", async () => {
  expect(await auditOptions(fakeStore([]), user)).toEqual({
    actions: [{ value: "create", label: "create", count: 3 }],
    collections: [{ value: "project", label: "project", count: 2 }],
  });
});

test("file reads follow Directus's rules: logos and Public for anyone, avatars signed in", () => {
  expect(mayRead(null, ["custom_logos"])).toBe(true);
  expect(mayRead(null, ["2026", "Public"])).toBe(true);
  expect(mayRead(null, ["avatars"])).toBe(false);
  expect(mayRead(user, ["avatars"])).toBe(true);
  expect(mayRead(user, ["reports"])).toBe(false);
  expect(mayRead(user, [])).toBe(false);
  expect(mayRead(staff, ["reports"])).toBe(true);
});
