import { expect, test } from "bun:test";
import { ForbiddenError } from "@dembrane/core";
import { MemoryStaffAudit, requireStaff, STAFF_POLICIES, staffPoliciesOf } from "../src";

const staff = { directusUserId: "d1", isStaff: true };
const user = { directusUserId: "d2", isStaff: false };

test("a Directus administrator holds every named staff permission, nobody else holds any", () => {
  expect([...staffPoliciesOf(staff)]).toEqual([...STAFF_POLICIES]);
  expect(staffPoliciesOf(user).size).toBe(0);
  expect(staffPoliciesOf(null).size).toBe(0);
});

test("a stored policy set replaces the derivation", () => {
  const narrow = { ...staff, staffPolicies: ["staff:training"] as const };
  expect([...staffPoliciesOf(narrow)]).toEqual(["staff:training"]);
});

test("each use is recorded before the action; a refusal records nothing", async () => {
  const audit = new MemoryStaffAudit();
  await requireStaff(audit, staff, {
    permission: "staff:billing",
    action: "billing_account.discount.update",
    targetType: "billing_account",
    targetId: "b1",
    detail: { percent_discount: 10 },
  });
  expect(audit.entries).toEqual([
    {
      permission: "staff:billing",
      action: "billing_account.discount.update",
      targetType: "billing_account",
      targetId: "b1",
      detail: { percent_discount: 10 },
      staffUserId: "d1",
    },
  ]);
  await expect(
    requireStaff(audit, user, { permission: "staff:billing", action: "x" }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    requireStaff(
      { ...audit, record: audit.record.bind(audit) },
      { ...staff, staffPolicies: [] },
      {
        permission: "staff:billing",
        action: "x",
      },
    ),
  ).rejects.toThrow("Staff-only");
  expect(audit.entries).toHaveLength(1);
});
