import { expect, test } from "bun:test";
import type { AgentContext } from "../src/context";
import { requestTool, TOOL_REQUEST_INBOX_CODE, type ToolDeps } from "../src/tools";

const NOW = new Date("2026-10-02T09:00:00.000Z");
const ctx = {
  clientName: "Claude",
  clientId: "client-1",
  grantId: "grant-1",
  appUserId: "app-1",
  directusUserId: "dir-1",
} as unknown as AgentContext;

/** A store whose insert runs `inTransaction` with a stand-in transaction, as Postgres would. */
function deps(samInbox: ToolDeps["samInbox"]) {
  const filed: Record<string, unknown>[] = [];
  const store = {
    async fileInsight(
      r: Record<string, unknown> & { inTransaction?: (tx: string, id: string) => Promise<void> },
    ) {
      filed.push(r);
      await r.inTransaction?.("the-tx", "insight-1");
      return "insight-1";
    },
  };
  return { filed, d: { store, now: () => NOW, samInbox } as unknown as ToolDeps };
}

test("with the inbox on, a tool request is queued for sam in the insight's transaction", async () => {
  const queued: {
    name: string;
    payload: { code: string; id: string; body: string };
    opts: unknown;
  }[] = [];
  const { filed, d } = deps({
    environment: "echo-next",
    sink: {
      enqueue: async (def, payload, opts) => {
        queued.push({
          name: def.name,
          payload: payload as { code: string; id: string; body: string },
          opts,
        });
      },
    },
  });
  expect(
    await requestTool(d, ctx, "export_pdf", "Export a report as PDF", "the Q3 report"),
  ).toEqual({ id: "insight-1", status: "new", kind: "tool_request" });
  expect(filed[0]).toMatchObject({ source: "agent_mcp", kind: "capability_gap" });
  expect(queued).toHaveLength(1);
  const [q] = queued;
  expect(q?.name).toBe("webhooks.sam-inbox");
  expect(q?.opts).toEqual({
    tx: "the-tx",
    workflowId: "sam-inbox:echo_support_mcp_tool_requested_v1:insight-1",
  });
  expect(q?.payload.code).toBe(TOOL_REQUEST_INBOX_CODE);
  expect(TOOL_REQUEST_INBOX_CODE).toBe("echo_support_mcp_tool_requested_v1");
  expect(q?.payload.id).toBe("insight-1");
  expect(JSON.parse(q?.payload.body ?? "")).toEqual({
    code: "echo_support_mcp_tool_requested_v1",
    json: {
      id: "insight-1",
      environment: "echo-next",
      message: "[Claude via MCP] Export a report as PDF\nExample: the Q3 report",
      source: "agent_mcp",
      kind: "tool_request",
      tool_name: "export_pdf",
      client_name: "Claude",
      client_id: "client-1",
      grant_id: "grant-1",
      app_user_id: "app-1",
      directus_user_id: "dir-1",
      created_at: NOW.toISOString(),
    },
  });
});

test("with the inbox off, a tool request is only filed, as before", async () => {
  const { filed, d } = deps(null);
  await requestTool(d, ctx, "export_pdf", "Export a report as PDF", null);
  expect(filed).toHaveLength(1);
  expect(filed[0]?.inTransaction).toBeUndefined();
});
