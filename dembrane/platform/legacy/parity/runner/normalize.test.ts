import { expect, test } from "bun:test";
import { withoutAdditiveErrorFields } from "./normalize";

test("the new error fields are dropped only where the old body lacks them", () => {
  const body = {
    detail: "Project not found",
    code: "project.not_found",
    params: {},
    action: "none",
  };
  expect(withoutAdditiveErrorFields(404, body, { detail: "Project not found" })).toEqual({
    detail: "Project not found",
  });
  // A success body with a `code` field of its own is compared as it is.
  expect(withoutAdditiveErrorFields(200, { code: "x" }, {})).toEqual({ code: "x" });
  // A detail that differs still differs.
  expect(withoutAdditiveErrorFields(404, { detail: "a", code: "c" }, { detail: "b" })).toEqual({
    detail: "a",
  });
});
