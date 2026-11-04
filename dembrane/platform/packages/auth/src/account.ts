import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import type { Auth } from "./auth";

const { auth_user, auth_account, auth_session, auth_two_factor, directus_users } = schema;

/**
 * Self-service identity changes for a signed-in user, on Better Auth's tables and with
 * Better Auth's hashing and secret encryption, so its own sign-in (password, TOTP) reads
 * what these write. Each change is mirrored onto directus_users (password hash, TFA
 * secret, status) so the row foreign keys point at stays truthful until the contract phase.
 * Every method takes the caller's own user id: nothing here can touch another user.
 */
export function identityAccount(auth: Pick<Auth, "$context">, db: Db) {
  const ctx = () => auth.$context;

  async function credentialHash(userId: string): Promise<string | null> {
    const [row] = await db
      .select({ hash: auth_account.password })
      .from(auth_account)
      .where(and(eq(auth_account.userId, userId), eq(auth_account.providerId, "credential")))
      .limit(1);
    return row?.hash ?? null;
  }

  async function passwordMatches(userId: string, password: string): Promise<boolean> {
    const hash = await credentialHash(userId);
    if (!hash) return false;
    return (await ctx()).password.verify({ hash, password });
  }

  async function twoFactorRow(userId: string) {
    const [row] = await db
      .select()
      .from(auth_two_factor)
      .where(eq(auth_two_factor.userId, userId))
      .limit(1);
    return row ?? null;
  }

  async function totpMatches(encryptedSecret: string, code: string): Promise<boolean> {
    const c = await ctx();
    const secret = await symmetricDecrypt({ key: c.secretConfig, data: encryptedSecret });
    return createOTP(secret).verify(code);
  }

  return {
    passwordMatches,

    /** Verifies the current password, then stores the new hash in both places. */
    async changePassword(
      userId: string,
      current: string,
      next: string,
    ): Promise<"ok" | "wrong_current"> {
      if (!(await passwordMatches(userId, current))) return "wrong_current";
      const hash = await (await ctx()).password.hash(next);
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(auth_account)
          .set({ password: hash, updatedAt: now })
          .where(and(eq(auth_account.userId, userId), eq(auth_account.providerId, "credential")));
        await tx
          .update(directus_users)
          .set({ password: hash })
          .where(eq(directus_users.id, userId));
      });
      return "ok";
    },

    /**
     * Starts TOTP enrolment: a fresh secret stored unverified (Better Auth's shape: secret
     * and backup codes encrypted), returned as the base32 secret and otpauth URL the
     * authenticator app scans. Enrolment completes with `enableTotp`.
     */
    async generateTotp(
      userId: string,
      password: string,
      issuer: string,
    ): Promise<{ secret: string; otpauth_url: string } | "wrong_password" | "already_enabled"> {
      if (!(await passwordMatches(userId, password))) return "wrong_password";
      const existing = await twoFactorRow(userId);
      if (existing?.verified) return "already_enabled";
      const c = await ctx();
      const secret = generateRandomString(32);
      const codes = Array.from({ length: 10 }, () => generateRandomString(10, "a-z", "0-9", "A-Z"));
      const encrypted = {
        secret: await symmetricEncrypt({ key: c.secretConfig, data: secret }),
        backupCodes: await symmetricEncrypt({ key: c.secretConfig, data: JSON.stringify(codes) }),
        verified: false,
      };
      if (existing)
        await db.update(auth_two_factor).set(encrypted).where(eq(auth_two_factor.id, existing.id));
      else await db.insert(auth_two_factor).values({ id: newId(), userId, ...encrypted });
      const [user] = await db
        .select({ email: auth_user.email })
        .from(auth_user)
        .where(eq(auth_user.id, userId))
        .limit(1);
      const encoded = base32.encode(secret, { padding: false });
      // The URL shape Directus returned, which the settings page renders as a QR code.
      const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(user?.email ?? "")}`;
      return {
        secret: encoded,
        otpauth_url: `otpauth://totp/${label}?secret=${encoded}&period=30&digits=6&algorithm=SHA1&issuer=${encodeURIComponent(issuer)}`,
      };
    },

    /** Completes enrolment when the code matches the stored secret. */
    async enableTotp(userId: string, code: string): Promise<"ok" | "invalid" | "not_started"> {
      const row = await twoFactorRow(userId);
      if (!row) return "not_started";
      if (!(await totpMatches(row.secret, code))) return "invalid";
      const c = await ctx();
      const plain = await symmetricDecrypt({ key: c.secretConfig, data: row.secret });
      await db.transaction(async (tx) => {
        await tx
          .update(auth_two_factor)
          .set({ verified: true })
          .where(eq(auth_two_factor.id, row.id));
        await tx.update(auth_user).set({ twoFactorEnabled: true }).where(eq(auth_user.id, userId));
        await tx
          .update(directus_users)
          .set({ tfa_secret: base32.encode(plain, { padding: false }) })
          .where(eq(directus_users.id, userId));
      });
      return "ok";
    },

    /** Turns TOTP off after a valid current code, in both places. */
    async disableTotp(userId: string, code: string): Promise<"ok" | "invalid" | "not_enabled"> {
      const row = await twoFactorRow(userId);
      if (!row?.verified) return "not_enabled";
      if (!(await totpMatches(row.secret, code))) return "invalid";
      await db.transaction(async (tx) => {
        await tx.delete(auth_two_factor).where(eq(auth_two_factor.id, row.id));
        await tx.update(auth_user).set({ twoFactorEnabled: false }).where(eq(auth_user.id, userId));
        await tx
          .update(directus_users)
          .set({ tfa_secret: null })
          .where(eq(directus_users.id, userId));
      });
      return "ok";
    },

    async totpEnabled(userId: string): Promise<boolean> {
      const [row] = await db
        .select({ on: auth_user.twoFactorEnabled })
        .from(auth_user)
        .where(eq(auth_user.id, userId))
        .limit(1);
      return Boolean(row?.on);
    },

    /** Profile picture on the identity (a file id), so Better Auth's user carries it too. */
    async setImage(userId: string, image: string | null): Promise<void> {
      await db
        .update(auth_user)
        .set({ image, updatedAt: new Date() })
        .where(eq(auth_user.id, userId));
    },

    /**
     * Suspends sign-in pending account deletion: Directus status suspended (Better Auth's
     * session hook refuses new sessions for it) and every live session revoked now, not
     * at expiry (spec M-18).
     */
    async suspend(userId: string, description: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(directus_users)
          .set({ status: "suspended", description })
          .where(eq(directus_users.id, userId));
        await tx.delete(auth_session).where(eq(auth_session.userId, userId));
      });
    },
  };
}

export type IdentityAccount = ReturnType<typeof identityAccount>;

/** Days between an in-app deletion request and the purge that deletes the account. */
export const DELETION_GRACE_DAYS = 30;

const DELETION_NOTE = /^deletion requested in-app on (\d{4}-\d{2}-\d{2}), purge within \d+ days$/;

/**
 * The note a suspension for an in-app deletion request carries on directus_users.description.
 * It is the only marker of the request, so the writer and the purge share this one format.
 */
export function deletionRequestNote(day: Date): string {
  return `deletion requested in-app on ${day.toISOString().slice(0, 10)}, purge within ${DELETION_GRACE_DAYS} days`;
}

/** The UTC day a deletion was requested, or null when the note is anything else. */
export function deletionRequestedOn(description: string | null | undefined): Date | null {
  const day = description ? DELETION_NOTE.exec(description)?.[1] : undefined;
  if (!day) return null;
  const at = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day ? null : at;
}
