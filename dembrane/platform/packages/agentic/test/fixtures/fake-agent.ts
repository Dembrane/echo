// A scripted agent for run tests: three steps shaped like a real turn (ack with a plan, one
// lookup, the answer), with an optional hook to hang inside a step.
import type { ModelMessage } from "ai";
import type { Agent, StepEvent, StepInput, StepResult } from "../../src/agent/types";

const call = (id: string, name: string, input: Record<string, unknown>): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: name, input }],
});
const result = (id: string, name: string, value: unknown): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: name,
      output: { type: "json", value: value as never },
    },
  ],
});

export interface FakeAgentOptions {
  /** Awaited inside step 1 after its tool started: the durability test hangs here. */
  readonly inLookup?: () => Promise<void>;
  readonly answer?: string;
  /** Every step input the agent saw, for assertions. */
  readonly seen?: StepInput[];
}

export function fakeAgent(o: FakeAgentOptions = {}): Agent {
  return {
    async step(input, emit: (e: StepEvent) => Promise<void>): Promise<StepResult> {
      o.seen?.push(input);
      const mid = `agent-msg-${input.stepIndex}`;
      if (input.stepIndex === 0) {
        const ack = { message: "I'll look through the conversations.", plan: ["Read", "Answer"] };
        await emit({ type: "text-delta", messageId: mid, delta: "I'll look" });
        await emit({
          type: "model-end",
          messageId: mid,
          content: "",
          toolCalls: [{ id: "c-ack", name: "ack", args: ack }],
          model: "fake",
        });
        await emit({
          type: "tool-start",
          runId: "t-ack",
          toolCallId: "c-ack",
          name: "ack",
          input: ack,
        });
        const out = {
          kind: "progress_update",
          update: ack.message,
          plan: ack.plan,
          visible_to_user: true,
        };
        await emit({
          type: "tool-end",
          runId: "t-ack",
          toolCallId: "c-ack",
          name: "ack",
          input: ack,
          output: out,
        });
        return {
          responseMessages: [call("c-ack", "ack", ack), result("c-ack", "ack", out)],
          done: false,
        };
      }
      if (input.stepIndex === 1) {
        const args = { limit: 20 };
        await emit({
          type: "model-end",
          messageId: mid,
          content: "",
          toolCalls: [{ id: "c-list", name: "listProjectConversations", args }],
          model: "fake",
        });
        await emit({
          type: "tool-start",
          runId: "t-list",
          toolCallId: "c-list",
          name: "listProjectConversations",
          input: args,
        });
        await o.inLookup?.();
        const out = { project_id: input.ctx.projectId, count: 0, conversations: [] };
        await emit({
          type: "tool-end",
          runId: "t-list",
          toolCallId: "c-list",
          name: "listProjectConversations",
          input: args,
          output: out,
        });
        return {
          responseMessages: [
            call("c-list", "listProjectConversations", args),
            result("c-list", "listProjectConversations", out),
          ],
          done: false,
        };
      }
      const answer = o.answer ?? "People mostly want more parking near the station.";
      await emit({ type: "text-delta", messageId: mid, delta: answer.slice(0, 10) });
      await emit({ type: "text-delta", messageId: mid, delta: answer.slice(10) });
      await emit({
        type: "model-end",
        messageId: mid,
        content: answer,
        toolCalls: [],
        model: "fake",
      });
      return { responseMessages: [{ role: "assistant", content: answer }], done: true };
    },
  };
}
