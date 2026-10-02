import { expect, test } from "bun:test";
import { overageInboxMessage } from "../src";

test("an overage notice goes to sam's inbox as echo_billing_overage_v1 under its notification id", () => {
  const payload = {
    id: "ep-1:closed:20261002T101500",
    environment: "production",
    message: "Cap episode ended.",
    workspace_id: "w1",
  };
  expect(overageInboxMessage(payload)).toEqual({
    code: "echo_billing_overage_v1",
    json: payload,
    id: "ep-1:closed:20261002T101500",
  });
  expect(overageInboxMessage({ ...payload, id: "" })).toBeNull();
});
