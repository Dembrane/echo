import type { Access } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import type { Logger } from "@dembrane/observability";
import { publish } from "@dembrane/realtime";
import type { AgentData, TurnContext } from "../agent/data";
import * as canvas from "../canvas/service";
import { canvasStorage } from "../canvas/storage";
import * as data from "../data";

export interface BindingDeps {
  readonly db: Db;
  readonly access: Access;
  readonly enableCanvas: boolean;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

const generationChannel = (reportId: string) => `canvas:generation:${reportId}`;

/**
 * The agent's reads and writes for one turn, bound to the caller and the turn's project and
 * chat. Each method runs the service operation of the matching /api/agentic route with the
 * caller's identity, so the route's access rules apply unchanged. The project and chat come
 * from the run row, never from the model, which is what the x-dembrane-* headers could not
 * guarantee.
 */
export function bindAgentData(deps: BindingDeps, who: Signed, ctx: TurnContext): AgentData {
  const now = deps.now ?? (() => new Date());
  const d: data.DataDeps = { db: deps.db, access: deps.access, now };
  const store = canvasStorage(deps.db);
  const c: canvas.CanvasDeps = {
    store,
    access: deps.access,
    enableCanvas: deps.enableCanvas,
    now,
    publishGeneration: (reportId) =>
      publish(store.sql, generationChannel(reportId), { type: "generation" }, deps.logger),
  };
  const p = ctx.projectId;
  const chat = ctx.chatId;
  return {
    projectSettings: () => data.projectSettings(d, who, p),
    projectTags: () => data.projectTags(d, who, p),
    editProjectTags: (add, remove) => data.editProjectTags(d, who, p, add, remove),
    projectGoal: () => data.projectGoal(d, who, p),
    methodologies: () => data.methodologies(d, who, p),
    reports: async () => (await data.reports(d, who, p)).reports as Record<string, unknown>[],
    report: (reportId) => data.report(d, who, p, reportId),
    monitor: (windowSeconds) => data.monitor(d, who, p, windowSeconds),

    conversations: (q) =>
      data.conversations(d, who, p, {
        limit: q.limit,
        offset: q.offset ?? 0,
        conversationId: q.conversationId ?? null,
        transcriptQuery: q.transcriptQuery ?? null,
      }),
    focusedConversations: (limit, offset) => {
      // A turn outside a chat has no focus; answer as an empty selection would.
      if (!chat)
        return Promise.resolve({
          project_id: p,
          project_chat_id: null,
          total: 0,
          count: 0,
          offset,
          has_more: false,
          conversations: [],
        });
      return data.focusedConversations(d, who, p, chat, limit, offset);
    },
    transcript: (conversationId) => data.transcript(d, who, conversationId),
    searchHome: (query, limit) => data.searchHome(d, who, query, limit),

    chats: (limit, workspaceWide) => data.chats(d, who, p, limit, workspaceWide),
    chatMessages: (chatId, limit) => data.chatMessages(d, who, chatId, limit),

    memory: () => data.memory(d, who, p),
    writeMemory: (body) => data.writeMemory(d, who, p, body),
    amendMemory: (memoryId, content) => data.amendMemory(d, who, memoryId, content),
    forgetMemory: (memoryId) => data.forgetMemory(d, who, memoryId),

    supportRequest: (body) => data.supportRequest(d, who, p, { ...body, chat_id: chat }),
    noteInsight: (body) => data.noteInsight(d, who, p, { ...body, chat_id: chat }),
    editInsight: (insightId, body) => data.editInsight(d, who, insightId, body),
    retractInsight: (insightId, reason) => data.retractInsight(d, who, insightId, reason),

    canvases: () => canvas.canvases(c, who, p, chat),
    canvasActivity: (limit) => canvas.canvasActivity(c, who, p, chat, limit),
    canvas: (canvasId) => canvas.canvas(c, who, p, chat, canvasId),
    canvasHistory: (canvasId, limit) => canvas.canvasHistory(c, who, p, chat, canvasId, limit),
    editCanvas: (canvasId, instruction, html) =>
      canvas.editCanvas(c, who, p, chat, canvasId, instruction, html),
    addCanvasHostItem: (canvasId, body) =>
      canvas.addCanvasHostItem(c, who, p, chat, canvasId, body),
    removeCanvasHostItem: (canvasId, body) =>
      canvas.removeCanvasHostItem(c, who, p, chat, canvasId, body),
    canvasLoop: (canvasId, action) => canvas.canvasLoop(c, who, p, chat, canvasId, action),
  };
}
