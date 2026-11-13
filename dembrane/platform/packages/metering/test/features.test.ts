import { describe, expect, test } from "bun:test";
import { classifyOperation, FEATURE_RULES } from "../src/features";

describe("classifyOperation", () => {
  const cases: [string, string, string][] = [
    // Chat
    ["POST /api/chats/:chat_id", "chat", "Replies"],
    ["GET /api/chats/:chat_id/suggestions", "chat", "Suggestions"],
    ["POST /api/chats/:chat_id/suggestions", "chat", "Suggestions"],
    ["POST /api/chats/:chat_id/add-context", "chat", "Chat"],
    ["POST /api/v2/bff/chats", "chat", "Chat"],
    // Assistant
    ["agentic.turn.run", "assistant", "Assistant turns"],
    ["agentic.turn", "assistant", "Assistant turns"],
    ["POST /api/agentic/runs", "assistant", "New runs"],
    ["POST /api/agentic/runs/:run_id/messages", "assistant", "Follow-up messages"],
    // Reports
    ["reports.generate", "reports", "Report generation"],
    ["POST /api/projects/:project_id/create-report", "reports", "Reports"],
    // Map
    ["map.group", "map", "Groups"],
    ["map.fact_check", "map", "Fact checks"],
    ["POST /api/v2/bff/map/:project_id/generate", "map", "Map"],
    // Analysis
    ["popcorn.tick.manual", "analysis", "Popcorn ticks"],
    ["popcorn.tick.scheduled", "analysis", "Popcorn ticks"],
    ["popcorn.tick.translation", "analysis", "Popcorn translation"],
    ["POST /api/v2/bff/popcorn/loops", "analysis", "Popcorn"],
    ["analysis.run", "analysis", "Analysis runs"],
    ["POST /api/v2/bff/analysis/runs", "analysis", "Analysis"],
    // Canvas
    ["canvas.tick", "canvas", "Canvas ticks"],
    ["POST /api/v2/bff/canvases/:id/preview", "canvas", "Canvas"],
    // Portal
    ["POST /api/verify/generate", "portal", "Verify"],
    ["POST /api/conversations/:conversation_id/get-reply", "portal", "Explore"],
    [
      "POST /api/v2/projects/:project_id/portal-editor/try",
      "portal",
      "Try it in the portal editor",
    ],
    // Recording
    ["conversations.chunk", "recording", "Transcription"],
    ["conversations.finish", "recording", "Finishing"],
    ["conversations.finalize", "recording", "Finalize and summary"],
    ["conversations.final-transcript", "recording", "Final transcript"],
    ["conversations.summarize", "recording", "Conversation summaries"],
    ["POST /api/conversations/:conversation_id/summarize", "recording", "Conversation summaries"],
    ["POST /api/conversations/:conversation_id/generate-title", "recording", "Titles and tags"],
    ["POST /api/conversations/:conversation_id/retranscribe", "recording", "Retranscribe"],
    ["POST /api/participant/conversations/:conversation_id/upload-text", "recording", "Recording"],
    // Voice input
    ["POST /api/stateless/transcribe", "voice", "Voice input"],
    // Samples and demos
    ["accounts.demo-build", "samples", "Demo builds"],
    ["samples.seed-best-practices", "samples", "Sample projects"],
    ["samples.backfill-best-practices", "samples", "Sample projects"],
  ];

  test.each(cases)("%s is %s: %s", (operation, group, label) => {
    expect(classifyOperation(operation)).toMatchObject({ group, label });
  });

  test("puts anything unknown in Other under its raw key", () => {
    expect(classifyOperation("something.unknown")).toMatchObject({
      group: "other",
      label: "something.unknown",
    });
    expect(classifyOperation("GET /api/v2/me")).toMatchObject({
      group: "other",
      label: "GET /api/v2/me",
    });
  });

  test("matches a route by its path, not a lookalike", () => {
    expect(classifyOperation("POST /api/chatsx").group).toBe("other");
    expect(classifyOperation("mapping.thing").group).toBe("other");
    expect(classifyOperation("accounts.demo-builder")).toMatchObject({
      group: "other",
      label: "accounts.demo-builder",
    });
  });

  test("names the group in plain English", () => {
    expect(classifyOperation("POST /api/stateless/transcribe")).toEqual({
      group: "voice",
      group_label: "Voice input",
      label: "Voice input",
    });
    expect(classifyOperation("accounts.demo-build").group_label).toBe("Samples and demos");
    expect(classifyOperation("POST /api/verify/:id/generate")).toMatchObject({
      group: "portal",
      group_label: "Portal",
      label: "Verify",
    });
  });

  test("an empty or missing operation is Unlabelled under Other", () => {
    for (const op of ["", null])
      expect(classifyOperation(op)).toEqual({
        group: "other",
        group_label: "Other",
        label: "Unlabelled",
      });
  });

  test("every rule compiles and the list keeps the frontend's order", () => {
    for (const r of FEATURE_RULES) expect(() => new RegExp(r.pattern)).not.toThrow();
    expect(FEATURE_RULES[0]).toEqual({
      pattern: "^POST \\/api\\/chats\\/:chat_id$",
      group: "chat",
      label: "Replies",
    });
    expect(FEATURE_RULES).toHaveLength(33);
  });
});
