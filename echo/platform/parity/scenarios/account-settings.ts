import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricEncrypt } from "better-auth/crypto";
import { id, orgs, users, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";
import { hash } from "./account-invites-mine";

// /api/user-settings, public registration and the public invite probe. Identity changes
// (password, two-factor, registration, avatar) now land in Better Auth's tables as well
// as directus_users, so their row diffs differ by design; the scenarios still check the
// status, the body and that Directus's own row changes the same way.

/** The parity API's AUTH_SECRET (see parity/README and the start command in docs/porting.md). */
const AUTH_SECRET = "parity-secret-parity-secret-parity-secret-00";
const TOTP_RAW = "parity-totp-secret-parity-totp-s";
const TOTP_B32 = base32.encode(TOTP_RAW, { padding: false });
const TOTP_ENC = await symmetricEncrypt({ key: AUTH_SECRET, data: TOTP_RAW });
const code = () => createOTP(TOTP_RAW).totp();
const password = process.env.PARITY_USER_PASSWORD ?? "";

const tfaStarted = `insert into auth_two_factor (id, user_id, secret, backup_codes, verified) values ('${id("ad", 50)}', '${users.alice.directus}', '${TOTP_ENC}', 'x', false);`;
const tfaOn = `insert into auth_two_factor (id, user_id, secret, backup_codes, verified) values ('${id("ad", 50)}', '${users.alice.directus}', '${TOTP_ENC}', 'x', true);
update auth_user set two_factor_enabled = true where id = '${users.alice.directus}';
update directus_users set tfa_secret = '${TOTP_B32}' where id = '${users.alice.directus}';`;

// 1x1 transparent PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");

const s = "/api/user-settings";
const inv = (k: number) => id("aa", k);
const invites = `
insert into workspace_invite (id, workspace_id, email, role, invited_by, expires_at, created_at, accepted_at) values
 ('${inv(60)}', '${workspaces.aDefault}', 'guest@example.com', 'member', '${users.alice.app}', '2099-01-01T00:00:00Z', '2026-09-01T09:00:00Z', null),
 ('${inv(61)}', '${workspaces.aDefault}', 'guest@example.com', 'member', '${users.alice.app}', '2026-01-01T00:00:00Z', '2026-09-01T09:01:00Z', null),
 ('${inv(62)}', '${workspaces.aDefault}', 'guest@example.com', 'member', '${users.alice.app}', '2099-01-01T00:00:00Z', '2026-09-01T09:02:00Z', '2026-09-02T00:00:00Z');
insert into org_invite (id, org_id, email, role, invited_by, expires_at, created_at) values
 ('${inv(63)}', '${orgs.a}', 'guest@example.com', 'billing', '${users.alice.app}', '2099-01-01T00:00:00Z', '2026-09-01T09:03:00Z');`;

const register = (over: Record<string, unknown> = {}) => ({
  email: "Brand.New@Example.com",
  password: "Str0ng!pass",
  first_name: "Brand",
  last_name: " New ",
  verification_url: "http://localhost:5173/verify-email",
  ...over,
});

export default scenarios([
  // ── profile ──
  { name: "settings: alice reads her profile", as: "alice", method: "GET", path: `${s}/me` },
  {
    name: "settings: a user who never onboarded reads theirs",
    as: "dave",
    method: "GET",
    path: `${s}/me`,
  },
  {
    name: "settings: two-factor on reads as enabled",
    as: "alice",
    method: "GET",
    path: `${s}/me`,
    setup: tfaOn,
  },
  { name: "settings: anonymous", as: "anonymous", method: "GET", path: `${s}/me` },
  {
    name: "settings: rename writes Directus and the app name",
    as: "alice",
    method: "PATCH",
    path: `${s}/name`,
    body: { first_name: "Alicia\r\n" },
  },
  {
    name: "settings: rename before onboarding writes only Directus",
    as: "dave",
    method: "PATCH",
    path: `${s}/name`,
    body: { first_name: "David" },
  },
  {
    name: "settings: rename is validated",
    as: "alice",
    method: "PATCH",
    path: `${s}/name`,
    body: {},
  },

  // ── password ──
  {
    name: "settings: a weak new password is 400 with every rule",
    as: "alice",
    method: "PATCH",
    path: `${s}/password`,
    body: { current_password: "x", new_password: "short" },
  },
  {
    name: "settings: a wrong current password is 400",
    as: "alice",
    method: "PATCH",
    path: `${s}/password`,
    body: { current_password: "wrong-password", new_password: "N3w!password" },
  },
  {
    name: "settings: change password",
    as: "alice",
    method: "PATCH",
    path: `${s}/password`,
    body: { current_password: password, new_password: "N3w!password" },
    ignoreFields: ["password"],
    differs: "identity: the new hash also lands in Better Auth's auth_account",
  },
  {
    name: "settings: password is validated",
    as: "alice",
    method: "PATCH",
    path: `${s}/password`,
    body: { new_password: 1 },
  },

  // ── two-factor ──
  {
    name: "settings: generating a TOTP secret needs the password",
    as: "alice",
    method: "POST",
    path: `${s}/tfa/generate`,
    body: { password: "wrong" },
  },
  {
    name: "settings: generate a TOTP secret",
    as: "alice",
    method: "POST",
    path: `${s}/tfa/generate`,
    body: { password },
    ignoreFields: ["secret", "otpauth_url"],
    differs: "identity: the pending secret is stored in Better Auth's auth_two_factor",
  },
  {
    name: "settings: a wrong code does not enable two-factor",
    as: "alice",
    method: "POST",
    path: `${s}/tfa/enable`,
    body: { otp: "000000", secret: TOTP_B32 },
    setup: tfaStarted,
  },
  {
    name: "settings: enable two-factor with a valid code",
    as: "alice",
    method: "POST",
    path: `${s}/tfa/enable`,
    body: async () => ({ otp: await code(), secret: TOTP_B32 }),
    setup: tfaStarted,
    differs: "identity: enrolment completes in Better Auth (auth_two_factor, auth_user)",
  },
  {
    name: "settings: disabling when it is off is 400",
    as: "alice",
    method: "POST",
    path: `${s}/tfa/disable`,
    body: { otp: "000000" },
  },
  {
    name: "settings: disabling with a wrong code is 400",
    as: "alice",
    method: "POST",
    path: `${s}/tfa/disable`,
    body: { otp: "000000" },
    setup: tfaOn,
  },
  {
    name: "settings: disable two-factor with a valid code",
    as: "alice",
    method: "POST",
    path: `${s}/tfa/disable`,
    body: async () => ({ otp: await code() }),
    setup: tfaOn,
    differs: "identity: two-factor is removed from Better Auth (auth_two_factor, auth_user)",
  },
  {
    name: "settings: tfa enable is validated",
    as: "alice",
    method: "POST",
    path: `${s}/tfa/enable`,
    body: {},
  },

  // ── uploads ──
  {
    name: "settings: upload an avatar",
    as: "alice",
    method: "POST",
    path: `${s}/avatar`,
    form: { file: { filename: "my_avatar.png", type: "image/png", base64: PNG } },
    ignoreFields: [
      "filename_disk",
      "uploaded_on",
      "created_on",
      "modified_on",
      "storage",
      "metadata",
      "width",
      "height",
    ],
    differs: "identity: the avatar is also set on Better Auth's user (auth_user.image)",
  },
  {
    name: "settings: upload a whitelabel logo",
    as: "alice",
    method: "POST",
    path: `${s}/whitelabel-logo`,
    form: { file: { filename: "logo.png", type: "image/png", base64: PNG } },
    ignoreFields: [
      "filename_disk",
      "uploaded_on",
      "created_on",
      "modified_on",
      "storage",
      "metadata",
      "width",
      "height",
    ],
  },
  {
    name: "settings: an SVG logo is refused",
    as: "alice",
    method: "POST",
    path: `${s}/whitelabel-logo`,
    form: { file: { filename: "logo.svg", type: "image/svg+xml", base64: SVG } },
    differs: "L-23: uploads to the public logo folder are raster images only",
  },
  {
    name: "settings: upload needs a file",
    as: "alice",
    method: "POST",
    path: `${s}/avatar`,
    form: { other: "x" },
  },
  {
    name: "settings: remove an avatar that is not set",
    as: "alice",
    method: "DELETE",
    path: `${s}/avatar`,
  },
  {
    name: "settings: remove a logo that is not set",
    as: "alice",
    method: "DELETE",
    path: `${s}/whitelabel-logo`,
  },

  // ── deletion ──
  {
    name: "settings: account deletion suspends the user",
    as: "bob",
    method: "DELETE",
    path: `${s}/account`,
  },
  {
    name: "settings: account deletion, anonymous",
    as: "anonymous",
    method: "DELETE",
    path: `${s}/account`,
  },

  // ── registration ──
  {
    name: "register: a new email creates an unverified identity",
    as: "anonymous",
    method: "POST",
    path: "/api/v2/auth/register",
    body: register(),
    headers: { "x-forwarded-for": "203.0.113.1" },
    differs: "identity: registration creates the identity in Better Auth (auth_user, auth_account)",
  },
  {
    name: "register: a known email answers the same and changes nothing",
    as: "anonymous",
    method: "POST",
    path: "/api/v2/auth/register",
    body: register({ email: users.alice.email }),
  },
  {
    name: "register: an email that fails the shape check is silently ignored",
    as: "anonymous",
    method: "POST",
    path: "/api/v2/auth/register",
    body: register({ email: "no-dot@localhost" }),
  },
  {
    name: "register: validation reports every field",
    as: "anonymous",
    method: "POST",
    path: "/api/v2/auth/register",
    body: { email: "x", password: "short", first_name: "", verification_url: "u" },
  },
  {
    name: "register: a weak password is a value error",
    as: "anonymous",
    method: "POST",
    path: "/api/v2/auth/register",
    body: register({ password: "longenough" }),
  },

  // ── public invite probe ──
  ...(
    [
      ["pending workspace invite", inv(60)],
      ["expired workspace invite", inv(61)],
      ["accepted workspace invite", inv(62)],
      ["pending org invite", inv(63)],
    ] as const
  ).map(([what, k]) => ({
    name: `invite-status: ${what}`,
    as: "anonymous" as const,
    method: "GET" as const,
    path: "/api/v2/auth/invite-status",
    query: { email: " Guest@Example.com ", h: hash(k) },
    setup: invites,
  })),
  {
    name: "invite-status: a deleted workspace",
    as: "anonymous",
    method: "GET",
    path: "/api/v2/auth/invite-status",
    query: { email: "guest@example.com", h: hash(inv(60)) },
    setup: `${invites}\nupdate workspace set deleted_at = now() where id = '${workspaces.aDefault}';`,
  },
  {
    name: "invite-status: a wrong hash is not found",
    as: "anonymous",
    method: "GET",
    path: "/api/v2/auth/invite-status",
    query: { email: "guest@example.com", h: "f".repeat(32) },
    setup: invites,
  },
  {
    name: "invite-status: a malformed email is not found",
    as: "anonymous",
    method: "GET",
    path: "/api/v2/auth/invite-status",
    query: { email: "nope", h: "x" },
  },
  {
    name: "invite-status: parameters are required",
    as: "anonymous",
    method: "GET",
    path: "/api/v2/auth/invite-status",
  },
]);
