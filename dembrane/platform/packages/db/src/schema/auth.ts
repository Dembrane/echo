import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Better Auth's tables. A user's id is the id of their directus_users row, so every
// foreign key to directus_users keeps working until the contract phase moves them here.

export const auth_user = pgTable("auth_user", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auth_session = pgTable(
  "auth_session",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => auth_user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // The browser the dashboard signed in from: a random id it keeps in local storage.
    deviceId: text("device_id"),
    // True while the person has not yet chosen to replace their sessions on other browsers.
    // A held session signs nobody in.
    held: boolean("held").notNull().default(false),
    // When the session last made a request, to the nearest few minutes.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_session_user_id_index").on(t.userId)],
);

// One row each time someone signed in while the account was signed in on another browser:
// what we count per org to see how often an account is used in two places.
export const auth_sign_in_overlap = pgTable(
  "auth_sign_in_overlap",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => auth_user.id, { onDelete: "cascade" }),
    // The held session. Not a foreign key: the row outlives the session.
    sessionId: uuid("session_id").notNull(),
    deviceId: text("device_id"),
    otherSessions: integer("other_sessions").notNull(),
    otherDevices: integer("other_devices").notNull(),
    // When any of the other sessions last made a request.
    otherLastSeenAt: timestamp("other_last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when the person chose to sign in anyway; null when they turned back.
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
  },
  (t) => [
    index("auth_sign_in_overlap_user_id_index").on(t.userId),
    index("auth_sign_in_overlap_session_id_index").on(t.sessionId),
  ],
);

export const auth_account = pgTable(
  "auth_account",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => auth_user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_account_user_id_index").on(t.userId)],
);

export const auth_verification = pgTable(
  "auth_verification",
  {
    id: uuid("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_verification_identifier_index").on(t.identifier)],
);

export const auth_two_factor = pgTable(
  "auth_two_factor",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => auth_user.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("auth_two_factor_user_id_index").on(t.userId)],
);
