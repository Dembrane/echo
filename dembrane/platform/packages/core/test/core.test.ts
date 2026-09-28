import { expect, test } from "bun:test";
import {
  BadRequestError,
  ERROR_ACTIONS,
  ERROR_CATALOG,
  errorBody,
  ForbiddenError,
  NotFoundError,
  newId,
  PlatformError,
  StatusError,
} from "../src";

test("errors carry status, code, params and the catalog's action", () => {
  const e = new NotFoundError("project.not_found");
  expect(e).toBeInstanceOf(PlatformError);
  expect([e.status, e.code, e.name, e.message]).toEqual([
    404,
    "project.not_found",
    "NotFoundError",
    "Project not found",
  ]);
  expect(e.action).toBe("none");
  expect(new ForbiddenError("access.forbidden").status).toBe(403);
});

test("detail templates are filled from params, and a message overrides them", () => {
  const e = new ForbiddenError("billing.tier_required", {
    params: { required: "innovator", tier: "free" },
  });
  expect(e.message).toBe("This action requires the innovator tier (currently free).");
  expect(errorBody(e)).toEqual({
    detail: "This action requires the innovator tier (currently free).",
    code: "billing.tier_required",
    params: { required: "innovator", tier: "free" },
    action: "upgrade",
  });
  const passed = new BadRequestError("request.invalid", { message: "from a library" });
  expect(passed.message).toBe("from a library");
  expect(new StatusError(413, "request.too_large").status).toBe(413);
});

test("structured details stay the detail", () => {
  const e = new NotFoundError("project.not_found", { details: { projectId: "p1" } });
  expect(errorBody(e).detail).toEqual({ projectId: "p1" });
});

test("every code is namespaced, has a known action and a description", () => {
  for (const [code, spec] of Object.entries(ERROR_CATALOG)) {
    expect(code).toMatch(/^[a-z_]+\.[a-z0-9_]+$/);
    expect(ERROR_ACTIONS as readonly string[]).toContain(spec.action);
    expect(spec.description.length).toBeGreaterThan(10);
  }
});

test("ids are uuid v7 and sort by creation time", () => {
  const a = newId();
  const b = newId();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a < b).toBe(true);
});
