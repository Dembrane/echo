import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMAIL_RE, isValidEmail } from "./emailRule";

// The same table as platform/packages/account/test/email.test.ts.
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

describe("the registration email rule", () => {
	it.each(cases)("%s is %s", (email, ok) => {
		expect(isValidEmail(email)).toBe(ok);
	});

	it("is the pattern the server applies", () => {
		const file = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../../platform/packages/account/src/email.ts",
		);
		const literal = readFileSync(file, "utf8").match(
			/export const EMAIL_RE = (\/.+\/[a-z]*);/,
		)?.[1];
		expect(literal).toBe(String(EMAIL_RE));
	});
});
