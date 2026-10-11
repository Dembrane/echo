import { describe, expect, test } from "bun:test";
import { classifyEdit, clientAiTraining, trainingVerdict } from "../src";

const consented = { trainingConsentAt: "2026-10-11T10:00:00Z", trainingConsentVersion: "1" };

describe("training consent", () => {
  test("the client's choice is the project's override, else the workspace's, else opt-out", () => {
    expect(clientAiTraining(null, null)).toBe("opt-out");
    expect(clientAiTraining(null, "opt-in")).toBe("opt-in");
    expect(clientAiTraining("opt-out", "opt-in")).toBe("opt-out");
    expect(clientAiTraining("opt-in", null)).toBe("opt-in");
    expect(clientAiTraining("yes", "maybe")).toBe("opt-out");
  });

  test("a participant's consent is not enough without the client", () => {
    expect(
      trainingVerdict({ projectAiTraining: null, workspaceAiTraining: null, ...consented }),
    ).toEqual({ eligible: false, reason: "client_not_opted_in" });
  });

  test("the client's opt-in is not enough without the participant", () => {
    expect(
      trainingVerdict({
        projectAiTraining: "opt-in",
        workspaceAiTraining: null,
        trainingConsentAt: null,
        trainingConsentVersion: null,
      }),
    ).toEqual({ eligible: false, reason: "participant_not_consented" });
  });

  test("both together make a conversation trainable, unless it was deleted", () => {
    const both = { projectAiTraining: null, workspaceAiTraining: "opt-in", ...consented };
    expect(trainingVerdict(both)).toEqual({ eligible: true, consentVersion: "1" });
    expect(trainingVerdict({ ...both, deletedAt: "2026-10-12T00:00:00Z" })).toEqual({
      eligible: false,
      reason: "deleted",
    });
  });
});

describe("classifyEdit", () => {
  test("approving unchanged text is an accept", () => {
    expect(classifyEdit("a", "a ", true)?.kind).toBe("accept");
    expect(classifyEdit("a", null, true)?.kind).toBe("accept");
  });

  test("changed text is an edit that keeps both versions", () => {
    expect(classifyEdit("a", "b", true)).toEqual({
      kind: "edit",
      payload: { before: "a", after: "b", approved: true },
    });
    expect(classifyEdit("a", "b", false)?.kind).toBe("edit");
  });

  test("nothing changed and nothing approved is no signal", () => {
    expect(classifyEdit("a", "a", false)).toBeNull();
  });
});
