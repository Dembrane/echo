import { newId } from "@echo/core";
import type { Db } from "@echo/db";
import type { Logger } from "@echo/observability";
import { type NotificationAction, type NotificationSeverity, severityFor } from "./events";
import { type NotificationStorage, notificationStorage } from "./storage";

export interface Emit {
  readonly audienceUserId: string;
  readonly eventCode: string;
  readonly title: string;
  readonly message?: string | null;
  readonly action?: NotificationAction;
  readonly severity?: NotificationSeverity;
  readonly actorUserId?: string | null;
  readonly refOrgId?: string | null;
  readonly refWorkspaceId?: string | null;
  readonly refProjectId?: string | null;
  readonly refChatId?: string | null;
  readonly refReportId?: string | null;
  readonly refConversationId?: string | null;
  readonly refInviteId?: string | null;
  readonly params?: Record<string, unknown> | null;
  /** Breadcrumb; computed from the refs when omitted. */
  readonly scope?: string | null;
  readonly expiresAt?: string | null;
}

/**
 * Writes one inbox row per (event, recipient). Notifications are a side effect: a failed
 * write is logged and never fails the action that caused it.
 */
export class Notifier {
  private readonly store: NotificationStorage;

  constructor(
    db: Db,
    private readonly logger?: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.store = notificationStorage(db);
  }

  async emit(e: Emit): Promise<string | null> {
    try {
      const scope = e.scope === undefined ? await this.scope(e) : e.scope;
      const id = newId();
      const now = this.clock().toISOString();
      await this.store.insert({
        id,
        audience_user_id: e.audienceUserId,
        actor_user_id: e.actorUserId ?? null,
        event_code: e.eventCode,
        severity: e.severity ?? severityFor(e.eventCode),
        action: e.action ?? "NONE",
        title: e.title,
        message: e.message ?? null,
        scope,
        params: e.params ?? null,
        ref_org_id: e.refOrgId ?? null,
        ref_workspace_id: e.refWorkspaceId ?? null,
        ref_project_id: e.refProjectId ?? null,
        ref_chat_id: e.refChatId ?? null,
        ref_report_id: e.refReportId ?? null,
        ref_conversation_id: e.refConversationId ?? null,
        ref_invite_id: e.refInviteId ?? null,
        expires_at: e.expiresAt ?? null,
        created_at: now,
        updated_at: now,
      });
      return id;
    } catch (err) {
      this.logger?.warn({ err, event: e.eventCode }, "emit notification failed");
      return null;
    }
  }

  /** The same notification to each recipient, skipping the actor (no "you did X" rows). */
  async emitToAudience(
    audience: readonly string[],
    e: Omit<Emit, "audienceUserId">,
  ): Promise<string[]> {
    const created: string[] = [];
    for (const uid of audience) {
      if (e.actorUserId && uid === e.actorUserId) continue;
      const id = await this.emit({ ...e, audienceUserId: uid });
      if (id) created.push(id);
    }
    return created;
  }

  /** "Org › Workspace › Project", frozen at emit time so a later rename keeps history. */
  private async scope(e: Emit): Promise<string | null> {
    try {
      const n = await this.store.names({
        orgId: e.refOrgId ?? null,
        workspaceId: e.refWorkspaceId ?? null,
        projectId: e.refProjectId ?? null,
      });
      const parts = [n.org, n.workspace, n.project].filter((p): p is string => Boolean(p));
      return parts.length ? parts.join(" › ") : null;
    } catch {
      return null;
    }
  }
}
