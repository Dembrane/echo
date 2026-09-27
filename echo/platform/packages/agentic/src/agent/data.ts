/**
 * What the agent's tools read and write, as the caller. The Python agent reached these
 * over HTTP with the host's forwarded token (echo_client.py); here each method runs the
 * same service operation in-process with the caller's identity, so every access rule of
 * the matching /api/agentic route applies unchanged. Results are the JSON bodies those
 * routes return. A refused or missing resource throws the route's PlatformError.
 *
 * One instance is bound to one turn: its caller, project and chat.
 */
export type Json = Record<string, unknown>;

export interface AgentData {
  // ── project ─────────────────────────────────────────────────────────
  /** GET /agentic/projects/{p}/settings */
  projectSettings(): Promise<Json>;
  /** GET /v2/bff/tags?project_id={p}: the tag rows. */
  projectTags(): Promise<Json[]>;
  /** POST /agentic/projects/{p}/tags */
  editProjectTags(add: string[], remove: string[]): Promise<Json>;
  /** GET /agentic/projects/{p}/goal */
  projectGoal(): Promise<Json>;
  /** GET /agentic/projects/{p}/methodologies */
  methodologies(): Promise<Json>;
  /** GET /agentic/projects/{p}/reports: the `reports` list. */
  reports(): Promise<Json[]>;
  /** GET /agentic/projects/{p}/reports/{id} */
  report(reportId: string): Promise<Json>;
  /** GET /agentic/projects/{p}/monitor */
  monitor(windowSeconds: number): Promise<Json>;

  // ── conversations ───────────────────────────────────────────────────
  /** GET /agentic/projects/{p}/conversations */
  conversations(q: {
    limit: number;
    offset?: number;
    conversationId?: string;
    transcriptQuery?: string;
  }): Promise<Json>;
  /** GET /agentic/projects/{p}/focused-conversations for this turn's chat. */
  focusedConversations(limit: number, offset: number): Promise<Json>;
  /** GET /conversations/{id}/transcript: the transcript text. */
  transcript(conversationId: string): Promise<string>;
  /** GET /home/search, as the dashboard's global search answers the caller. */
  searchHome(query: string, limit: number): Promise<Json>;

  // ── chats ───────────────────────────────────────────────────────────
  /** GET /agentic/projects/{p}/chats */
  chats(limit: number, workspaceWide: boolean): Promise<Json[]>;
  /** GET /agentic/chats/{id}/messages */
  chatMessages(chatId: string, limit: number): Promise<Json[]>;

  // ── memory ──────────────────────────────────────────────────────────
  /** GET /agentic/projects/{p}/memory */
  memory(): Promise<Json>;
  /** POST /agentic/projects/{p}/memory */
  writeMemory(body: { scope: string; content: string; memory_key?: string | null }): Promise<Json>;
  /** PATCH /agentic/memories/{id} */
  amendMemory(memoryId: string, content: string): Promise<Json>;
  /** DELETE /agentic/memories/{id} */
  forgetMemory(memoryId: string): Promise<Json>;

  // ── insights and support ────────────────────────────────────────────
  /** POST /agentic/projects/{p}/support-request */
  supportRequest(body: {
    message: string;
    page_context?: string | null;
    message_id?: string | null;
  }): Promise<Json>;
  /** POST /agentic/projects/{p}/insight */
  noteInsight(body: {
    kind: string;
    content: string;
    suggested_capability?: string | null;
    message_id?: string | null;
  }): Promise<Json>;
  /** PATCH /agentic/insights/{id} */
  editInsight(
    insightId: string,
    body: { content?: string; kind?: string; suggested_capability?: string },
  ): Promise<Json>;
  /** POST /agentic/insights/{id}/retract */
  retractInsight(insightId: string, reason: string): Promise<Json>;

  // ── canvases (only registered when the project has canvas on) ───────
  /** GET /agentic/projects/{p}/canvases */
  canvases(): Promise<Json[]>;
  /** GET /agentic/projects/{p}/chats/{chat}/canvas-activity */
  canvasActivity(limit: number): Promise<Json>;
  /** GET /agentic/projects/{p}/canvases/{id} */
  canvas(canvasId: string): Promise<Json>;
  /** GET /agentic/projects/{p}/canvases/{id}/history */
  canvasHistory(canvasId: string, limit: number): Promise<Json>;
  /** POST /agentic/projects/{p}/canvases/{id}/edit */
  editCanvas(canvasId: string, instruction: string, contentHtml: string): Promise<Json>;
  /** POST /agentic/projects/{p}/canvases/{id}/host-items */
  addCanvasHostItem(
    canvasId: string,
    body: { text: string; target_tab: string; person?: string | null; message_id?: string | null },
  ): Promise<Json>;
  /** POST /agentic/projects/{p}/canvases/{id}/host-items/remove */
  removeCanvasHostItem(
    canvasId: string,
    body: { item: string; message_id?: string | null },
  ): Promise<Json>;
  /** POST /agentic/projects/{p}/canvases/{id}/loop/{action} */
  canvasLoop(canvasId: string, action: "pause" | "resume" | "stop"): Promise<Json>;
}

/** The fixed facts of one turn, which the Python agent took from x-dembrane-* headers. */
export interface TurnContext {
  readonly projectId: string;
  /** The run id; LangGraph's thread id. */
  readonly threadId: string;
  readonly chatId: string | null;
  readonly appUserId: string | null;
  /** Id of the user.message event that started the turn. */
  readonly messageId: string | null;
  readonly canvasEnabled: boolean;
  /** Where docs citations link to; empty cites bare paths. */
  readonly docsBaseUrl: string;
  /** Portal origin for getPortalLink. */
  readonly portalUrl: string;
}
