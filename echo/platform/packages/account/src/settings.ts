import {
  BadRequestError,
  NotFoundError,
  newId,
  PlatformError,
  ValidationError,
} from "@dembrane/core";
import { type Ctx, type Env, requireUser, v } from "@dembrane/http";
import { Hono } from "hono";
import type { AccountDeps } from "./deps";
import { passwordProblems } from "./password";
import { cleanName } from "./service";
import { accountStorage } from "./storage";

/** Directus's 401 for a wrong password, which the settings page shows as is. */
class InvalidCredentialsError extends PlatformError {
  readonly status = 401;
  readonly code = "invalid_credentials";
}

const INVALID_OTP = 'Invalid payload. "otp" is invalid.';
const TFA_ALREADY_SET = "Invalid payload. TFA Secret is already set for this user.";

/**
 * Uploads that land in a public folder must be images a browser renders inertly: raster
 * formats only, no SVG (spec L-23), and a size cap.
 */
const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * /api/user-settings: the caller's own profile, password, two-factor, avatar, whitelabel
 * logo and account deletion. Every write targets the caller's own ids from the session;
 * no route takes a user id, so nobody can change another user's email, role or password.
 */
export function settingsRoutes(deps: AccountDeps) {
  const store = accountStorage(deps.db);
  const base = "/api/user-settings";

  const upload = async (c: Ctx, folderName: string, field: "avatar" | "whitelabel_logo") => {
    const who = requireUser(c);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const file = form.file;
    if (!(file instanceof File)) {
      throw new ValidationError("Request validation failed", [
        {
          type: "missing",
          loc: ["body", "file"],
          msg: "Field required",
          input: null,
          url: "https://errors.pydantic.dev/2.12/v/missing",
        },
      ]);
    }
    const type = file.type || "image/png";
    const ext = IMAGE_TYPES[type];
    if (!ext) throw new BadRequestError("Upload a PNG, JPEG, WebP or GIF image");
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestError("Images can be at most 5 MB");

    const now = new Date();
    const folderId = (await store.folderId(folderName)) ?? (await store.createFolder(folderName));
    const id = newId();
    const key = `${id}.${ext}`;
    await deps.files.put(key, await file.arrayBuffer(), type);
    await store.insertFile(
      {
        id,
        storage: deps.settings.directusStorageLocation,
        filename_disk: key,
        filename_download: file.name || key,
        title: fileTitle(file.name || key),
        type,
        folder: folderId,
        uploaded_by: who.directusUserId,
        filesize: file.size,
      },
      now,
    );
    await store.updateDirectusUser(who.directusUserId, { [field]: id });
    if (field === "avatar") await deps.identity.setImage(who.directusUserId, id);
    return c.json({ file_id: id });
  };

  const remove = async (c: Ctx, field: "avatar" | "whitelabel_logo") => {
    const who = requireUser(c);
    const current = await store.directusFileRef(who.directusUserId, field);
    await store.updateDirectusUser(who.directusUserId, { [field]: null });
    if (current && field === "avatar") await deps.identity.setImage(who.directusUserId, null);
    if (current) {
      try {
        const disk = await store.deleteFile(current);
        if (disk) await deps.files.delete(disk);
      } catch (err) {
        deps.logger?.warn({ err, fileId: current }, "old upload not deleted");
      }
    }
    return c.json({ status: "ok" });
  };

  return new Hono<Env>()
    .get(`${base}/me`, async (c) => {
      const who = requireUser(c);
      const p = await store.settingsProfile(who.directusUserId);
      if (!p) throw new NotFoundError("User not found");
      return c.json({ ...p, tfa_enabled: await deps.identity.totpEnabled(who.directusUserId) });
    })
    .patch(`${base}/password`, async (c) => {
      const who = requireUser(c);
      const { body } = await v.validate(c, {
        body: { current_password: v.str(), new_password: v.str() },
      });
      const problems = passwordProblems(body.new_password);
      if (problems.length) throw new BadRequestError(problems.join("; "));
      const r = await deps.identity.changePassword(
        who.directusUserId,
        body.current_password,
        body.new_password,
      );
      if (r === "wrong_current") throw new BadRequestError("Current password is incorrect");
      return c.json({ status: "ok" });
    })
    .post(`${base}/tfa/generate`, async (c) => {
      const who = requireUser(c);
      const { body } = await v.validate(c, { body: { password: v.str() } });
      const r = await deps.identity.generateTotp(who.directusUserId, body.password, "dembrane");
      if (r === "wrong_password") throw new InvalidCredentialsError("Invalid user credentials.");
      if (r === "already_enabled") throw new BadRequestError(TFA_ALREADY_SET);
      return c.json(r);
    })
    .post(`${base}/tfa/enable`, async (c) => {
      const who = requireUser(c);
      const { body } = await v.validate(c, { body: { otp: v.str(), secret: v.str() } });
      if (await deps.identity.totpEnabled(who.directusUserId))
        throw new BadRequestError(TFA_ALREADY_SET);
      const r = await deps.identity.enableTotp(who.directusUserId, body.otp);
      if (r !== "ok") throw new BadRequestError(INVALID_OTP);
      return c.json({ status: "ok" });
    })
    .post(`${base}/tfa/disable`, async (c) => {
      const who = requireUser(c);
      const { body } = await v.validate(c, { body: { otp: v.str() } });
      const r = await deps.identity.disableTotp(who.directusUserId, body.otp);
      if (r === "not_enabled")
        throw new BadRequestError(
          `Invalid payload. User "${who.directusUserId}" doesn't have TFA enabled.`,
        );
      if (r === "invalid") throw new BadRequestError(INVALID_OTP);
      return c.json({ status: "ok" });
    })
    .post(`${base}/whitelabel-logo`, (c) => upload(c, "custom_logos", "whitelabel_logo"))
    .delete(`${base}/whitelabel-logo`, (c) => remove(c, "whitelabel_logo"))
    .patch(`${base}/name`, async (c) => {
      const who = requireUser(c);
      const { body } = await v.validate(c, { body: { first_name: v.str() } });
      // Both names: the Directus profile, and app_user.display_name, which the app shows.
      await store.updateDirectusUser(who.directusUserId, { first_name: body.first_name });
      const cleaned = cleanName(body.first_name);
      const app = await store.appUser(who.directusUserId);
      if (app && cleaned) await store.updateAppUserDisplayName(app.id, cleaned, new Date());
      return c.json({ status: "ok" });
    })
    .post(`${base}/avatar`, (c) => upload(c, "avatars", "avatar"))
    .delete(`${base}/avatar`, (c) => remove(c, "avatar"))
    .delete(`${base}/account`, async (c) => {
      const who = requireUser(c);
      // App Store guideline 5.1.1(v): sign-in stops now, data is purged within 30 days.
      const day = new Date().toISOString().slice(0, 10);
      await deps.identity.suspend(
        who.directusUserId,
        `deletion requested in-app on ${day}, purge within 30 days`,
      );
      deps.logger?.info({ userId: who.directusUserId }, "account suspended pending deletion");
      return c.json({ status: "ok" });
    });
}

/** Directus's title for an upload: the file name without extension, words capitalised. */
export function fileTitle(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  return stem
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
