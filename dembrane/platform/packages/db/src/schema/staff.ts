import { index, json, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// One row per use of a staff permission (spec 7 H-14): who, which permission, what they
// did and to which resource. Written in the same request as the action, read by the
// staff console and by audits. Staff support sessions keep their own customer-facing
// trail in support_access_event.
export const staff_audit_event = pgTable(
  "staff_audit_event",
  {
    id: uuid("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Directus user id of the staff member; app_user may not exist for staff. */
    staffUserId: uuid("staff_user_id").notNull(),
    permission: text("permission").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detail: json("detail"),
    requestId: text("request_id"),
  },
  (t) => [
    index("staff_audit_event_staff_user_id_index").on(t.staffUserId),
    index("staff_audit_event_target_index").on(t.targetType, t.targetId),
    index("staff_audit_event_created_at_index").on(t.createdAt),
  ],
);
