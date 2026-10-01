import { hasStaffPolicy, requireStaff, type StaffAudit } from "@dembrane/access";
import { BadRequestError, ForbiddenError, newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Ctx, type Env, requireUser, v } from "@dembrane/http";
import type { Logger } from "@dembrane/observability";
import type { ObjectStorage } from "@dembrane/storage";
import { Hono } from "hono";
import { erasePerson, erasurePlan, exportPerson, findPerson } from "./privacy";
import { privacyStorage } from "./privacy-storage";

export interface PrivacyRouteDeps {
  readonly db: Db;
  readonly staffAudit: StaffAudit;
  readonly files: ObjectStorage;
  readonly audio: ObjectStorage;
  readonly audioKeyOf: (path: string) => string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/**
 * Data subject requests (staff:privacy): export everything tied to one person, and erase
 * them. The person is named by email in the body, never in the path, so it stays out of
 * access logs, and audit rows carry the user id, not the address, so the trail outlives an
 * erasure without keeping what was erased.
 */
export function privacyRoutes(deps: PrivacyRouteDeps) {
  const store = privacyStorage(deps.db);
  const now = deps.now ?? (() => new Date());
  const app = new Hono<Env>();
  const A = "/api/v2/admin/people";

  /** Refuses before the lookup, so only staff learn whether an address has an account. */
  const gate = (c: Ctx) => {
    const who = requireUser(c);
    if (!hasStaffPolicy(who, "staff:privacy")) throw new ForbiddenError("access.staff_only");
    return who;
  };
  const audit = (c: Ctx, action: string, userId: string, detail: Record<string, unknown>) =>
    requireStaff(deps.staffAudit, requireUser(c), {
      permission: "staff:privacy",
      action,
      targetType: "user",
      targetId: userId,
      detail,
      requestId: c.get("requestId"),
    });

  app.post(`${A}/export`, async (c) => {
    gate(c);
    const { body } = await v.validate(c, { body: { email: v.email() } });
    const person = await findPerson(store, body.email);
    const exportId = newId();
    const key = `exports/people/${person.id}/${exportId}.zip`;
    await audit(c, "person.export", person.id, { export_id: exportId, key });
    const out = await exportPerson(
      {
        store,
        files: deps.files,
        audio: deps.audio,
        audioKeyOf: deps.audioKeyOf,
        logger: deps.logger,
        now,
      },
      person,
      exportId,
      key,
    );
    return c.json(out, 201);
  });

  app.post(`${A}/erase`, async (c) => {
    gate(c);
    const { body } = await v.validate(c, {
      body: {
        email: v.email(),
        dry_run: v.withDefault(v.bool(), true),
        confirm_email: v.optional(v.str()),
        allow_orphan_orgs: v.withDefault(v.bool(), false),
      },
    });
    const person = await findPerson(store, body.email);
    if (body.dry_run) {
      await audit(c, "person.erase.plan", person.id, {});
      return c.json({ status: "dry_run", ...(await erasurePlan(store, person)) });
    }
    if ((body.confirm_email ?? "").trim().toLowerCase() !== person.email)
      throw new BadRequestError("privacy.confirm_email_mismatch");
    await audit(c, "person.erase", person.id, { allow_orphan_orgs: body.allow_orphan_orgs });
    return c.json(
      await erasePerson({ store, files: deps.files, logger: deps.logger }, person, {
        allowOrphanOrgs: body.allow_orphan_orgs,
      }),
    );
  });

  return app;
}
