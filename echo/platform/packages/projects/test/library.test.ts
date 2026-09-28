import { expect, test } from "bun:test";
import type { Access } from "@echo/access";
import { ForbiddenError, NotFoundError } from "@echo/core";
import type { Signed } from "@echo/http";
import {
  getAspect,
  getAspectSegment,
  getView,
  type LibraryDeps,
  projectViews,
} from "../src/library";

const mine = "f0000000-0000-4000-8000-000000000001";
const theirs = "f0000000-0000-4000-8000-000000000002";
const alice: Signed = {
  appUserId: "a0000000-0000-4000-8000-000000000002",
  directusUserId: "d0000000-0000-4000-8000-000000000002",
  isStaff: false,
};

/** Access that grants project:read on one project only and records what was asked. */
function deps(): LibraryDeps & { asked: string[] } {
  const asked: string[] = [];
  const access = {
    async project(_who: Signed, id: string, policy: string) {
      asked.push(`${id}:${policy}`);
      if (id !== mine) throw new ForbiddenError("no");
      return { tier: null };
    },
  } as unknown as Access;
  return {
    asked,
    access,
    library: {
      latestRunViews: async (projectId) => [{ id: "v1", project: projectId, aspects: [] }],
      view: async (id) => (id === "v1" ? { projectId: mine, row: { id: "v1" } } : null),
      aspect: async (id) =>
        id === "a1"
          ? { projectId: theirs, row: { id: "a1" } }
          : id === "orphan"
            ? { projectId: null, row: { id: "orphan" } }
            : null,
      aspectSegment: async (id) => (id === "q1" ? { projectId: mine, row: { id: "q1" } } : null),
    },
  };
}

test("library reads need project:read on the owning project", async () => {
  const d = deps();
  expect(await projectViews(d, alice, mine)).toEqual([{ id: "v1", project: mine, aspects: [] }]);
  expect(await getView(d, alice, "v1")).toEqual({ id: "v1" });
  expect(await getAspectSegment(d, alice, "q1")).toEqual({ id: "q1" });
  expect(d.asked).toEqual([`${mine}:project:read`, `${mine}:project:read`, `${mine}:project:read`]);
});

test("another tenant's library is refused, before anything is read from it", async () => {
  const d = deps();
  await expect(projectViews(d, alice, theirs)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(getAspect(d, alice, "a1")).rejects.toBeInstanceOf(ForbiddenError);
});

test("missing and orphaned rows are not found", async () => {
  const d = deps();
  await expect(getView(d, alice, "nope")).rejects.toBeInstanceOf(NotFoundError);
  await expect(getAspect(d, alice, "orphan")).rejects.toBeInstanceOf(NotFoundError);
  await expect(getAspectSegment(d, alice, "nope")).rejects.toBeInstanceOf(NotFoundError);
  expect(d.asked).toEqual([]);
});

test("a caller who never onboarded is refused like every BFF route", async () => {
  const d = deps();
  await expect(projectViews(d, { ...alice, appUserId: null }, mine)).rejects.toThrow(
    "User not onboarded",
  );
});
