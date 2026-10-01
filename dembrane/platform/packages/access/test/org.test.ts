import { describe, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "@dembrane/core";
import { Access, MemoryAccessStore, ORG_POLICIES, orgRoleHas, STAFF_POLICIES } from "../src";

// Who may use an organisation's customer account: owners, admins and
// the billing role; plain members see nothing of it; outsiders do not see it exists.
describe("org account policies", () => {
  const store = new MemoryAccessStore();
  const access = new Access(store);
  for (const role of ["owner", "admin", "billing", "member"])
    store.orgRoles.set(`org:${role}-user`, role);
  const who = (id: string) => ({ appUserId: id, directusUserId: `d-${id}` });

  test("owners, admins and billing hold every account policy; members none", () => {
    for (const p of ORG_POLICIES) {
      expect(orgRoleHas("owner", p)).toBe(true);
      expect(orgRoleHas("admin", p)).toBe(true);
      expect(orgRoleHas("billing", p)).toBe(true);
      expect(orgRoleHas("member", p)).toBe(false);
      expect(orgRoleHas(null, p)).toBe(false);
      expect(orgRoleHas("superuser", p)).toBe(false);
    }
  });

  test("Access.org: 404 for outsiders and users without an app_user, 403 for members", async () => {
    expect(await access.org(who("billing-user"), "org", "account:sign")).toEqual({
      role: "billing",
    });
    await expect(access.org(who("member-user"), "org", "account:read")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(access.org(who("stranger"), "org", "account:read")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      access.org({ appUserId: null, directusUserId: "d" }, "org", "account:read"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("staff hold staff:accounts", () => {
    expect(STAFF_POLICIES).toContain("staff:accounts");
  });
});
