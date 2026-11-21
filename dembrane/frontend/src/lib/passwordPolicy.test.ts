import { describe, expect, it } from "vitest";
import { passwordLength, validatePassword } from "./passwordPolicy";

describe("password length", () => {
	it("counts an emoji as one character, as the server does", () => {
		// Seven code points, eight UTF-16 units: the server says it is too short.
		const sevenWithEmoji = "Ab1!xy\u{1F600}";
		expect(sevenWithEmoji.length).toBe(8);
		expect(passwordLength(sevenWithEmoji)).toBe(7);
		expect(validatePassword(sevenWithEmoji).rules.minLength).toBe(false);
		expect(validatePassword(sevenWithEmoji).isValid).toBe(false);
	});

	it("accepts eight characters when one of them is an emoji", () => {
		const eightWithEmoji = "Ab1!xyz\u{1F600}";
		expect(passwordLength(eightWithEmoji)).toBe(8);
		expect(validatePassword(eightWithEmoji).isValid).toBe(true);
	});
});
