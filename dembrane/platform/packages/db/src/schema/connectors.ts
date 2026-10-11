import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
// Circular on purpose: project and app_user live in the baseline file, and the foreign key
// callbacks run only after both modules have loaded.
import { app_user, project } from "./index";

// Connectors: material from other apps (a Miro board, later email, meetings, forms) that
// reaches a project as conversations. A connection is one person's sign-in to an app; a
// source is what that sign-in feeds into one project. Each input a source produces is a
// conversation row pointing back at the source (conversation.connector_source_id).

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * One person's OAuth link to an app account (for Miro, a team). Tokens are sealed with
 * CONNECTOR_TOKEN_KEY (AES-256-GCM) before they are written; nothing reads them in clear
 * from the database.
 */
export const connector_connection = pgTable(
  "connector_connection",
  {
    id: uuid("id").primaryKey(),
    app_user_id: uuid("app_user_id").notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    /** The app's own id for the account the person signed in to (Miro: team_id). */
    account_id: varchar("account_id", { length: 255 }).notNull(),
    account_name: varchar("account_name", { length: 255 }),
    external_user_id: varchar("external_user_id", { length: 255 }),
    access_token: text("access_token").notNull(),
    refresh_token: text("refresh_token"),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    scope: text("scope"),
    created_at: created(),
    updated_at: updated(),
  },
  (t) => [
    unique("connector_connection_user_account").on(t.app_user_id, t.provider, t.account_id),
    foreignKey({
      columns: [t.app_user_id],
      foreignColumns: [app_user.id],
      name: "connector_connection_app_user_id_foreign",
    }).onDelete("cascade"),
  ],
);

/**
 * What feeds a project: for Miro, one board and the frames picked on it. `voice` says whose
 * words its inputs are (participants, organisers or mixed) and is copied onto each input.
 * Removing a source deletes its inputs (the foreign key on conversation cascades).
 */
export const connector_source = pgTable(
  "connector_source",
  {
    id: uuid("id").primaryKey(),
    project_id: uuid("project_id").notNull(),
    /** Whose sign-in syncs it; null once that connection is gone, and syncing stops. */
    connection_id: uuid("connection_id"),
    provider: varchar("provider", { length: 32 }).notNull(),
    /** The app's id for the thing connected (Miro: board id). */
    external_id: varchar("external_id", { length: 255 }).notNull(),
    name: text("name"),
    url: text("url"),
    /** Provider settings; Miro: { frame_ids: string[] }. */
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    voice: varchar("voice", { length: 32 }).notNull(),
    created_by: uuid("created_by"),
    /** pending, syncing, ok or error. */
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    error: text("error"),
    last_synced_at: timestamp("last_synced_at", { withTimezone: true }),
    created_at: created(),
    updated_at: updated(),
  },
  (t) => [
    unique("connector_source_project_external").on(t.project_id, t.provider, t.external_id),
    index("connector_source_last_synced").on(t.last_synced_at),
    foreignKey({
      columns: [t.project_id],
      foreignColumns: [project.id],
      name: "connector_source_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.connection_id],
      foreignColumns: [connector_connection.id],
      name: "connector_source_connection_id_foreign",
    }).onDelete("set null"),
  ],
);
