import { expect, test } from "bun:test";
import { severityFor } from "../src";

test("severity comes from the event, info by default", () => {
  expect(severityFor("INVITE_CANCELLED")).toBe("destructive");
  expect(severityFor("ONBOARDING_FOLLOWUP")).toBe("action_required");
  expect(severityFor("WORKSPACE_GUEST_ADDED")).toBe("info");
});
