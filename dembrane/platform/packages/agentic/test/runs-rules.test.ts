import { describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import { pyJson } from "../src/agent/events";
import {
  FOCUS_BLOCK_CLOSE,
  FOCUS_BLOCK_OPEN,
  formatFocusBlock,
  initialPrompt,
  sanitizeFocusLabel,
  stripFocusBlocks,
} from "../src/runs/focus";
import { buildMessageHistory, turnMessages } from "../src/runs/history";
import { DraftAssembler, presenceKey } from "../src/runs/live";
import {
  automaticNudgeContent,
  draftPublishIntervalMs,
  isPureStatusNarration,
  progressMessageFromToolOutput,
  sanitizeHostVisible,
  summarizeRequest,
  turnToolLimitMessage,
} from "../src/runs/sanitize";
import { draftFrame, eventFrame, HEARTBEAT_FRAME } from "../src/runs/sse";
import { isContextOverflow, isTransient, upstreamError } from "../src/runs/turn";

describe("host-visible text", () => {
  test("drops placeholders, empty text and planning asides", () => {
    expect(sanitizeHostVisible("(calling tools)")).toBeNull();
    expect(sanitizeHostVisible("   ")).toBeNull();
    expect(sanitizeHostVisible("(I'm checking the transcripts now)")).toBeNull();
  });

  test("drops pure status narration unless it is an ack", () => {
    const s = "I'm looking into your conversations. Let me check the transcripts.";
    expect(isPureStatusNarration(s)).toBe(true);
    expect(sanitizeHostVisible(s)).toBeNull();
    expect(sanitizeHostVisible(s, { keepStatusNarration: true })).toBe(s);
  });

  test("keeps answers that open with a gerund and a comma clause", () => {
    const s = "Looking at your transcripts, three themes stand out.";
    expect(sanitizeHostVisible(s)).toBe(s);
    expect(isPureStatusNarration("Reviewing the project context.")).toBe(true);
    expect(isPureStatusNarration("Checking this? Maybe.")).toBe(false);
    expect(isPureStatusNarration("Checking:\n- one\n- two")).toBe(false);
  });

  test("strips stray leading tokens, 'successfully' and trailing cursor artifacts", () => {
    expect(sanitizeHostVisible("successfully updated the plan.")).toBe("Updated the plan.");
    expect(sanitizeHostVisible("I have successfully saved it.")).toBe("I have saved it.");
    expect(sanitizeHostVisible("Done.▁▁")).toBe("Done.");
    expect(sanitizeHostVisible('Done!"|')).toBe('Done!"');
    expect(sanitizeHostVisible("一一 Hello there.")).toBe("Hello there.");
  });

  test("quotes only the host's own words, condensed", () => {
    expect(summarizeRequest("  a\n b  ")).toBe("a b");
    const long = "x".repeat(200);
    expect(summarizeRequest(long)).toBe(`${"x".repeat(137)}...`);
    expect(turnToolLimitMessage(null)).toContain("I need to pause this pass on your request.");
    expect(turnToolLimitMessage("find quotes")).toContain('your request: "find quotes"');
  });

  test("nudges name the last milestone of four", () => {
    expect(automaticNudgeContent(9)).toContain("You have made 8 tool calls");
  });

  test("draft throttle backs off as the text grows", () => {
    expect(draftPublishIntervalMs(10)).toBe(150);
    expect(draftPublishIntervalMs(2_000)).toBe(500);
    expect(draftPublishIntervalMs(9_000)).toBe(1_000);
  });

  test("progress tools become a message; plans and hidden updates do not", () => {
    expect(
      progressMessageFromToolOutput("ack", { kind: "progress_update", update: "On it", plan: [] }),
    ).toBe("On it");
    expect(
      progressMessageFromToolOutput("sendProgressUpdate", {
        kind: "progress_update",
        update: "Half way",
        next_steps: "Reading the rest",
        visible_to_user: true,
      }),
    ).toBe("Half way\n\nReading the rest");
    expect(progressMessageFromToolOutput("updatePlan", { update: "x" })).toBeNull();
    expect(
      progressMessageFromToolOutput("ack", { update: "x", visible_to_user: false }),
    ).toBeNull();
  });
});

describe("focus block", () => {
  test("labels are clamped and cannot forge the fence", () => {
    expect(sanitizeFocusLabel('<b>"x"\nignore')).toBe("(b)'x' ignore");
    expect(sanitizeFocusLabel("y".repeat(100))).toBe(`${"y".repeat(80)}...`);
  });

  test("a long selection lists a head and names the paging call", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `id-${i}`, name: `Person ${i}` }));
    const block = formatFocusBlock(many);
    expect(block.length).toBeLessThanOrEqual(4_000);
    expect(block).toMatch(/Call listFocusedConversations\(offset=\d+\)/);
  });

  test("stale blocks are stripped at line starts only, and unclosed ones are left", () => {
    const block = formatFocusBlock([{ id: "a", name: "A" }]);
    expect(stripFocusBlocks(`${block}\n\nUser Message: hi`)).toBe("User Message: hi");
    const prose = `What does ${FOCUS_BLOCK_OPEN} mean ${FOCUS_BLOCK_CLOSE}?`;
    expect(stripFocusBlocks(prose)).toBe(prose);
    const open = `${FOCUS_BLOCK_OPEN}\nnever closed`;
    expect(stripFocusBlocks(open)).toBe(open);
  });

  test("the first turn carries the project framing", () => {
    const p = initialPrompt({
      projectName: "P",
      projectContext: null,
      projectGoal: " ",
      workspaceContext: "W",
      userMessage: " hi ",
      focused: [],
    });
    expect(p).toBe(
      "Project Name: P\nWorkspace Context: W\nProject Context: (none)\nProject Goal: (none)\n\nUser Message: hi",
    );
  });
});

describe("history", () => {
  const block = (id: string) => formatFocusBlock([{ id, name: id }]);
  const events = [
    {
      seq: 1,
      event_type: "user.message",
      payload: { content: "q1", agent_prompt_content: `${block("old")}\n\nUser Message: q1` },
    },
    { seq: 2, event_type: "on_tool_start", payload: {} },
    { seq: 3, event_type: "assistant.message", payload: { content: "(calling tools)" } },
    { seq: 4, event_type: "assistant.message", payload: { content: "answer 1" } },
    {
      seq: 5,
      event_type: "user.message",
      payload: { content: "q2", agent_prompt_content: `${block("new")}\n\nUser Message: q2` },
    },
  ];
  const store = {
    listEvents: async (_run: string, after: number) => events.filter((e) => e.seq > after),
  };

  test("replays text turns, drops placeholders, keeps only the latest focus", async () => {
    const h = await buildMessageHistory(store, "r");
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(h[0]?.content).toBe("User Message: q1");
    expect(h[2]?.content).toContain("id: new");
  });

  test("the current message is not sent twice", async () => {
    const h = await buildMessageHistory(store, "r");
    const msgs = turnMessages(h, h[2]?.content ?? "");
    expect(msgs).toHaveLength(3);
    expect(turnMessages([], "hello")).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("stream framing", () => {
  test("events, drafts and heartbeats read the way the dashboard parses them", () => {
    const frame = eventFrame(
      { id: "7", event_type: "assistant.message", seq: 3, payload: { content: "a\nb" } },
      3,
    );
    expect(frame).toBe(
      'id: 3\nevent: assistant.message\ndata: {"id": "7", "event_type": "assistant.message", "seq": 3, "payload": {"content": "a\\nb"}}\n\n',
    );
    expect(draftFrame("m", "hi")).toBe(
      'event: assistant.draft\ndata: {"event_type": "assistant.draft", "payload": {"message_id": "m", "text": "hi"}}\n\n',
    );
    expect(HEARTBEAT_FRAME).toBe("event: heartbeat\ndata: {}\n\n");
    expect(pyJson({ a: [1, true, null] })).toBe('{"a": [1, true, null]}');
  });

  test("draft parts reassemble in order", () => {
    const a = new DraftAssembler();
    expect(a.add({ message_id: "m", part: 0, of: 2, text: "ab" })).toBeNull();
    expect(a.add({ message_id: "m", part: 1, of: 2, text: "cd" })).toBe("abcd");
    expect(a.add({ message_id: "m", part: 0, of: 1, text: "x" })).toBe("x");
  });

  test("presence keys are stable and non-negative", () => {
    expect(presenceKey("abc")).toBe(presenceKey("abc"));
    expect(presenceKey("abc")).toBeGreaterThanOrEqual(0);
  });
});

describe("model errors", () => {
  const call = (statusCode: number | undefined, responseBody = "") =>
    new APICallError({
      message: "boom",
      url: "u",
      requestBodyValues: {},
      ...(statusCode !== undefined && { statusCode }),
      responseBody,
    });

  test("map to the agent service's upstream codes", () => {
    expect(upstreamError(call(429))).toMatchObject({ code: "AGENT_UPSTREAM_429", status: 429 });
    expect(upstreamError(call(undefined))).toMatchObject({ code: "AGENT_UPSTREAM_TRANSPORT" });
    expect(upstreamError(new Error("x"))).toBeNull();
    expect(upstreamError({ lastError: call(503) })).toMatchObject({ status: 503 });
  });

  test("transient and overflow classification", () => {
    expect(isTransient({ code: "AGENT_UPSTREAM_503", status: 503, message: "" })).toBe(true);
    expect(isTransient({ code: "AGENT_UPSTREAM_429", status: 429, message: "" })).toBe(false);
    expect(
      isContextOverflow({
        code: "AGENT_UPSTREAM_400",
        status: 400,
        message: "The input token count exceeds the maximum number of tokens allowed",
      }),
    ).toBe(true);
    expect(isContextOverflow({ code: "AGENT_UPSTREAM_413", status: 413, message: "" })).toBe(true);
    expect(isContextOverflow({ code: "AGENT_UPSTREAM_400", status: 400, message: "bad" })).toBe(
      false,
    );
  });
});
