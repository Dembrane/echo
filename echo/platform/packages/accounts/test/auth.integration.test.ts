import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createAuth } from "@dembrane/auth";
import { codeSignInGate } from "../src/prospect";
import { accountsRoutes } from "../src/routes";
import { mintStaffKey, revokeStaffKeys } from "../src/staff-key";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// Sign-in for accounts: codes go only to people with an account or an invitation, and
// sam's staff key is a bearer session that only a staff user can hold.
const run = admin ? describe : describe.skip;
const DB = `accounts_auth_${process.pid}`;

run("accounts sign-in", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const sent: { email: string; purpose: string }[] = [];
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    auth = createAuth({
      db: w.db,
      secret: "s".repeat(48),
      baseURL: "http://localhost:8080",
      trustedOrigins: ["http://localhost:5173"],
      secureCookies: false,
      defaultDirectusRoleId: null,
      codeSignInAllowed: codeSignInGate(w.deps),
      sendCode: async (email, _code, purpose) => {
        sent.push({ email, purpose });
      },
    });
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("a sign-in code goes to an existing user and to a named signer, never to a stranger", async () => {
    const ask = (email: string) =>
      auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    await ask("admin@example.test");
    await ask("stranger@example.test");
    expect(sent.map((s) => s.email)).toEqual(["admin@example.test"]);
    // Naming someone to sign lets a code reach them before they have an account.
    const offer = await call(w, "POST", `/api/v2/admin/accounts/${w.orgId}/offers`, "staff", {
      template: "subscription",
      language: "en",
      offer_name: "Testdorp",
      items: [{ description: "Licence", quantity: 1, unit_price_cents: 100, vat_rate_bps: 2100 }],
    });
    const docId = (offer.data as unknown as { document: { id: string } }).document.id;
    await call(w, "POST", `/api/v2/orgs/${w.orgId}/account/documents/${docId}/signer`, "admin", {
      name: "New Person",
      email: "new.person@example.test",
    });
    await ask("new.person@example.test");
    expect(sent.at(-1)?.email).toBe("new.person@example.test");
    // Other purposes are left to Better Auth: verifying an existing user's address still works.
    await auth.api.sendVerificationOTP({
      body: { email: "member@example.test", type: "email-verification" },
    });
    expect(sent.at(-1)).toEqual({ email: "member@example.test", purpose: "email-verification" });
  });

  test("a staff key is a bearer session of a staff user; others cannot hold one; revoking ends it", async () => {
    const minted = await mintStaffKey(w.db, "staff@example.test", "sam");
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${minted.key}` }),
    });
    expect(session?.user.id).toBe(w.people.staff.directusUserId);
    expect(minted.expiresAt.getTime() - Date.now()).toBeGreaterThan(300 * 86_400_000);
    await expect(mintStaffKey(w.db, "admin@example.test", "sam")).rejects.toThrow(/not staff/);
    await expect(mintStaffKey(w.db, "nobody@example.test", "sam")).rejects.toThrow(/no user/);
    expect(await revokeStaffKeys(w.db, "sam")).toBe(1);
    const gone = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${minted.key}` }),
    });
    expect(gone).toBeNull();
  });
});
