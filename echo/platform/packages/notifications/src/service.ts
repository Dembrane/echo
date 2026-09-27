import { ForbiddenError, NotFoundError } from "@echo/core";
import type { Signed } from "@echo/http";
import type { NotificationStorage } from "./storage";

/** The old API's answer for a signed-in user who never onboarded (no app_user row). */
function onboarded(who: Signed): string {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  return who.appUserId;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unexpired rows, newest first; `limit` is clamped to 1..200. */
export async function listNotifications(
  store: NotificationStorage,
  who: Signed,
  q: { unread_only: boolean; limit: number },
  now: Date,
) {
  const me = onboarded(who);
  const rows = await store.list(me, now, q.unread_only, Math.max(1, Math.min(q.limit, 200)));
  if (!rows.length) return [];
  const actorIds = [...new Set(rows.map((r) => r.actor_user_id).filter((x): x is string => !!x))];
  const actors = new Map(
    (await store.actors(actorIds)).map((a) => [
      a.id,
      { name: a.displayName ?? "", avatar: a.avatar ?? null },
    ]),
  );
  return rows.map((r) => {
    const actor = r.actor_user_id ? actors.get(r.actor_user_id) : undefined;
    return {
      id: r.id,
      event_code: r.event_code,
      severity: r.severity,
      action: r.action,
      title: r.title,
      message: r.message,
      scope: r.scope,
      params: r.params ?? null,
      created_at: r.created_at,
      expires_at: r.expires_at,
      read: Boolean(r.read_at),
      actor_user_id: r.actor_user_id,
      actor_name: actor?.name ?? null,
      actor_avatar: actor?.avatar ?? null,
      refs: {
        org_id: r.ref_org_id,
        workspace_id: r.ref_workspace_id,
        project_id: r.ref_project_id,
        chat_id: r.ref_chat_id,
        report_id: r.ref_report_id,
        conversation_id: r.ref_conversation_id,
        invite_id: r.ref_invite_id,
      },
    };
  });
}

export async function unreadCount(store: NotificationStorage, who: Signed, now: Date) {
  return { unread: await store.unreadCount(onboarded(who), now) };
}

/** Only the recipient may mark a row read; anyone else gets the same 404 as a missing row. */
export async function markRead(store: NotificationStorage, who: Signed, id: string, now: Date) {
  const me = onboarded(who);
  const row = UUID.test(id) ? await store.byId(id) : null;
  if (!row || row.audience !== me) throw new NotFoundError("Notification not found");
  if (!row.readAt) await store.markRead([id], now);
  return { status: "read" };
}

export async function markAllRead(store: NotificationStorage, who: Signed, now: Date) {
  const ids = await store.unreadIds(onboarded(who));
  await store.markRead(ids, now);
  return { status: "read", marked: ids.length };
}
