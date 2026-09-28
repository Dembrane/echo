import { expect, test } from "bun:test";
import { ClientSecretBox, hashToken, mintToken } from "../src/secrets";

// Produced by the Python API's store.encrypt_secret (cryptography's Fernet) with
// DIRECTUS SECRET "parity-test-secret": a client registered before cutover must still
// authenticate at /token afterwards.
const PYTHON_TOKEN =
  "gAAAAABqub6yN-y7tGoY0luN1YHySNcciHXrR46QO2XOJa_EGqlxhYcZjUuPJR2Poz9s5ff3j44PijhqWkDSJE2vP9xFPY-UKBIEL7sCTiQe_n9y-r-o69TRiKqEu0dyQRWUEBhQaWcVz2d1VrhtdVfB8Wn8Fgt74Qi_if0BcQb5pOIDIQom5pw=";
const PLAIN = "5f2b0c7e9a1d4e3f8b6a0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f";

test("a client secret the Python API encrypted decrypts to the same plain secret", () => {
  expect(new ClientSecretBox("parity-test-secret").decrypt(PYTHON_TOKEN)).toBe(PLAIN);
});

test("another Directus secret cannot read it", () => {
  expect(new ClientSecretBox("another-secret").decrypt(PYTHON_TOKEN)).toBeNull();
  expect(new ClientSecretBox("parity-test-secret").decrypt("not-a-token")).toBeNull();
});

test("what the platform encrypts round-trips in the Fernet layout", () => {
  const box = new ClientSecretBox("parity-test-secret");
  const token = box.encrypt(PLAIN);
  expect(token.startsWith("gAAAAA")).toBe(true);
  expect(box.decrypt(token)).toBe(PLAIN);
});

test("tokens carry their prefix and are stored as SHA-256 hex", () => {
  const raw = mintToken("dbr_at_");
  expect(raw).toMatch(/^dbr_at_[A-Za-z0-9_-]{43}$/);
  expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
