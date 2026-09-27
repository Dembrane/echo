import { expect, test } from "bun:test";
import { ForbiddenError, NotFoundError, newId, PlatformError } from "../src";

test("errors carry status, code and optional details", () => {
  const e = new NotFoundError("project not found", { projectId: "p1" });
  expect(e).toBeInstanceOf(PlatformError);
  expect([e.status, e.code, e.name]).toEqual([404, "not_found", "NotFoundError"]);
  expect(e.details).toEqual({ projectId: "p1" });
  expect(new ForbiddenError("no").status).toBe(403);
});

test("ids are uuid v7 and sort by creation time", () => {
  const a = newId();
  const b = newId();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a < b).toBe(true);
});
