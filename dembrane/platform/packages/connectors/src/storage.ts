import { isUuid } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, count, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";

const { connector_connection, connector_source, conversation } = schema;

export type ConnectionRow = typeof connector_connection.$inferSelect;
export type SourceRow = typeof connector_source.$inferSelect;

export function connectorStorage(db: Db) {
  return {
    /** The person's newest connection to the app; one app account each for now. */
    async connectionFor(appUserId: string, provider: string): Promise<ConnectionRow | null> {
      const [row] = await db
        .select()
        .from(connector_connection)
        .where(
          and(
            eq(connector_connection.app_user_id, appUserId),
            eq(connector_connection.provider, provider),
          ),
        )
        .orderBy(desc(connector_connection.updated_at))
        .limit(1);
      return row ?? null;
    },

    async connection(id: string): Promise<ConnectionRow | null> {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(connector_connection)
        .where(eq(connector_connection.id, id))
        .limit(1);
      return row ?? null;
    },

    /** Insert, or replace the tokens of the same person's link to the same account. */
    async saveConnection(row: typeof connector_connection.$inferInsert): Promise<ConnectionRow> {
      const [saved] = await db
        .insert(connector_connection)
        .values(row)
        .onConflictDoUpdate({
          target: [
            connector_connection.app_user_id,
            connector_connection.provider,
            connector_connection.account_id,
          ],
          set: {
            account_name: row.account_name,
            external_user_id: row.external_user_id,
            access_token: row.access_token,
            refresh_token: row.refresh_token,
            expires_at: row.expires_at,
            scope: row.scope,
            updated_at: row.updated_at,
          },
        })
        .returning();
      return saved as ConnectionRow;
    },

    async updateTokens(
      id: string,
      t: Pick<ConnectionRow, "access_token" | "refresh_token" | "expires_at" | "updated_at">,
    ) {
      await db.update(connector_connection).set(t).where(eq(connector_connection.id, id));
    },

    /** Removes the person's links to the app; their sources stop syncing (connection set null). */
    async deleteConnections(appUserId: string, provider: string) {
      await db
        .delete(connector_connection)
        .where(
          and(
            eq(connector_connection.app_user_id, appUserId),
            eq(connector_connection.provider, provider),
          ),
        );
    },

    async sources(projectId: string) {
      return db
        .select({ source: connector_source, inputs: count(conversation.id) })
        .from(connector_source)
        .leftJoin(
          conversation,
          and(
            eq(conversation.connector_source_id, connector_source.id),
            isNull(conversation.deleted_at),
          ),
        )
        .where(eq(connector_source.project_id, projectId))
        .groupBy(connector_source.id)
        .orderBy(asc(connector_source.created_at), asc(connector_source.id));
    },

    async source(id: string): Promise<SourceRow | null> {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(connector_source)
        .where(eq(connector_source.id, id))
        .limit(1);
      return row ?? null;
    },

    async sourceByExternal(projectId: string, provider: string, externalId: string) {
      const [row] = await db
        .select()
        .from(connector_source)
        .where(
          and(
            eq(connector_source.project_id, projectId),
            eq(connector_source.provider, provider),
            eq(connector_source.external_id, externalId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async insertSource(row: typeof connector_source.$inferInsert): Promise<SourceRow> {
      const [saved] = await db.insert(connector_source).values(row).returning();
      return saved as SourceRow;
    },

    async updateSource(id: string, set: Partial<typeof connector_source.$inferInsert>) {
      await db.update(connector_source).set(set).where(eq(connector_source.id, id));
    },

    /** Deletes the source; its inputs and their chunks go with it (cascade). */
    async deleteSource(id: string) {
      await db.delete(connector_source).where(eq(connector_source.id, id));
    },

    /** Sources with a connection whose last sync is older than `before`, oldest first. */
    async dueSources(before: Date, limit: number) {
      return db
        .select({ id: connector_source.id })
        .from(connector_source)
        .where(
          and(
            // A source whose connection is gone waits for someone to reconnect.
            isNotNull(connector_source.connection_id),
            or(
              isNull(connector_source.last_synced_at),
              lt(connector_source.last_synced_at, before),
            ),
          ),
        )
        .orderBy(asc(connector_source.last_synced_at))
        .limit(limit);
    },

    /** The inputs a source made: frame id to conversation id and its stored hash. */
    async inputs(sourceId: string) {
      return db
        .select({
          id: conversation.id,
          ref: conversation.external_ref,
          origin: conversation.origin,
        })
        .from(conversation)
        .where(eq(conversation.connector_source_id, sourceId));
    },
  };
}

export type ConnectorStorage = ReturnType<typeof connectorStorage>;
