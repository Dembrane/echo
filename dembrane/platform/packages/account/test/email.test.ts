import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EMAIL_RE, isEmailShape } from "../src/email";

// The same table as frontend/src/lib/emailRule.test.ts.
const cases: [string, boolean][] = [
  ["someone@example.com", true],
  ["  Someone@Example.COM ", true],
  ["first.last+tag@sub.example.co.uk", true],
  ["someone@example", false],
  ["someone@", false],
  ["@example.com", false],
  ["some one@example.com", false],
  ["someone@example..com", false],
  ["someone@.example.com", false],
  ["someone@example.com.", false],
  ["someone@@example.com", false],
];

test("registration accepts exactly the addresses the table says", () => {
  for (const [email, ok] of cases) expect([email, isEmailShape(email)]).toEqual([email, ok]);
});

test("the registration form applies the same rule", () => {
  const file = path.resolve(import.meta.dir, "../../../../frontend/src/lib/emailRule.ts");
  const source = readFileSync(file, "utf8");
  const literal = source.match(/export const EMAIL_RE = (\/.+\/[a-z]*);/)?.[1];
  expect(literal).toBe(String(EMAIL_RE));
});
