import { type Db, schema } from "@dembrane/db";
import { sql } from "drizzle-orm";
import { FEATURE_GROUP_LABELS, FEATURE_RULES } from "./features";

// Serialises syncs from workers that start together.
const SYNC_LOCK_KEY = 5_150_001;

/** Makes ai_feature_rule the backend's list, in order; returns the rows written. */
export async function syncFeatureRules(db: Db): Promise<number> {
  const rows = FEATURE_RULES.map((r, position) => ({
    position,
    pattern: r.pattern,
    feature_group: r.group,
    group_label: FEATURE_GROUP_LABELS[r.group],
    feature: r.label,
  }));
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SYNC_LOCK_KEY})`);
    await tx.delete(schema.ai_feature_rule);
    await tx.insert(schema.ai_feature_rule).values(rows);
  });
  return rows.length;
}
