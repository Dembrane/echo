import type { Capture } from "@dembrane/analytics";
import type { Overlap } from "@dembrane/auth";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Product analytics for a sign-in that met the account signed in on another browser, under
 * the email the dashboard identifies people by, with the orgs they belong to so it can be
 * counted per org. No address, place or browser name leaves the database.
 */
export function overlapReporter(db: Db, capture: Capture, logger: Logger) {
  return async (overlap: Overlap): Promise<void> => {
    try {
      const [user] = await db
        .select({ email: schema.auth_user.email })
        .from(schema.auth_user)
        .where(eq(schema.auth_user.id, overlap.userId))
        .limit(1);
      const orgs = await db
        .select({ id: schema.org_membership.org_id })
        .from(schema.org_membership)
        .where(
          and(
            eq(schema.org_membership.user_id, overlap.userId),
            isNull(schema.org_membership.deleted_at),
          ),
        );
      const properties = {
        org_ids: orgs.map((o) => o.id),
        device_id: overlap.deviceId,
        other_sessions: overlap.otherSessions,
        other_devices: overlap.otherDevices,
        // How long ago another browser last made a request: seconds means two people at
        // once, days means a browser left signed in.
        other_idle_seconds: overlap.otherLastSeenAt
          ? Math.round((Date.now() - overlap.otherLastSeenAt.getTime()) / 1000)
          : null,
      };
      logger.info(
        { userId: overlap.userId, outcome: overlap.outcome, ...properties },
        "sign-in overlap",
      );
      await capture(
        user?.email.toLowerCase() ?? overlap.userId,
        overlap.outcome === "held" ? "sign_in_elsewhere_detected" : "sign_in_elsewhere_replaced",
        properties,
      );
    } catch (err) {
      logger.warn({ err }, "sign-in overlap not reported");
    }
  };
}
