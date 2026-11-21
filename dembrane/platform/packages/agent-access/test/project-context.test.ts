import { expect, test } from "bun:test";
import { PROJECT_CONTEXT_BUDGET } from "@dembrane/core";
import type { AgentContext } from "../src/context";
import { fit } from "../src/mcp";
import type { Row } from "../src/storage";
import { getProject, type ToolDeps, updateProject } from "../src/tools";

// An outside agent reads the project context whole, so writing back what it read keeps it.

const PROJECT_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function fakes(context: string) {
  const stored: Row = { context, id: PROJECT_ID, name: "Bewonersavond", workspace_id: null };
  const d = {
    access: { project: async () => ({ project: { workspaceId: null } }) },
    now: () => new Date("2026-11-13T10:00:00Z"),
    store: {
      project: async () => ({ ...stored }),
      updateProject: async (_id: string, payload: Row) => {
        Object.assign(stored, payload);
        return { ...stored };
      },
    },
  } as unknown as ToolDeps;
  const ctx = {
    charge: async () => {},
    requireOrg: async () => "org-1",
    requireWrite: () => {},
    who: { appUserId: "user-1" },
  } as unknown as AgentContext;
  return { ctx, d, stored };
}

const long = Array.from(
  { length: 400 },
  (_, i) => `${i + 1}. Residents talk about the heat network at table ${i % 12}.`,
).join("\n");

test("get_project returns a context longer than the prompt budget whole", async () => {
  expect(long.length).toBeGreaterThan(PROJECT_CONTEXT_BUDGET);
  const { ctx, d } = fakes(long);
  const out = await getProject(d, ctx, PROJECT_ID);
  expect(out.context).toBe(long);
});

test("writing back what get_project read leaves the stored context as it was", async () => {
  const { ctx, d, stored } = fakes(long);
  const read = await getProject(d, ctx, PROJECT_ID);
  await updateProject(d, ctx, PROJECT_ID, { context: read.context });
  expect(stored.context).toBe(long);
});

test("the answer cap never cuts the context: a project has no list to shorten", async () => {
  const huge = "x".repeat(80_000);
  const { ctx, d } = fakes(huge);
  const out = fit((await getProject(d, ctx, PROJECT_ID)) as Row);
  expect(out.context).toBe(huge);
  expect(out.truncated).toBeUndefined();
});
