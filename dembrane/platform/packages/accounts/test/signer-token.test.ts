import { expect, test } from "bun:test";
import { signerInviteToken } from "../src/invite";
import type { DocumentRow } from "../src/storage";

// Signer links already sit in mailboxes: the token for the same document, address and
// moment must never change, whatever the code that makes it becomes.
test("the signer link token is pinned", () => {
  const doc = {
    id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
    signerEmail: "Anna@Example.test",
    signerInvitedAt: new Date("2026-09-28T09:00:00.000Z"),
  } as DocumentRow;
  expect(signerInviteToken("x".repeat(32), doc)).toBe("mlYMV5qbnd5EomGAGjydpMV8i-AJLwmm");
});
