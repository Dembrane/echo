import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { room as catalog } from "../catalog/room.gen";
import { presentError } from "../present";

// The data room's error codes in friendly words: ./room.ts, `export const room = { ... }
// satisfies Messages<"room">`, spread into ERROR_MESSAGES in ./index.ts.

const FALLBACKS = [
	"Something went wrong. Try again, and contact support if it keeps happening.",
	"You do not have permission to do this. Ask your admin for access.",
	"This is not available.",
];

const refusal = (code: keyof typeof catalog) => ({
	isAxiosError: true,
	message: "Request failed",
	response: {
		data: {
			action: catalog[code].action,
			code,
			detail: catalog[code].detail,
			params: {},
		},
		status: 403,
	},
});

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

describe("the room's error messages", { timeout: 30_000 }, () => {
	it("says who may bring in someone new, and what they can do instead", async () => {
		const p = await presentError(refusal("room.new_person_admins_only"), i18n);
		expect(p.message).toBe(
			"Only an owner or admin can invite someone who is not a member yet. You can add a colleague who is already a member.",
		);
		expect(p.action).toBe("contact_admin");
	});

	it("has its own words for every room code, never a fallback", async () => {
		for (const code of Object.keys(catalog) as (keyof typeof catalog)[]) {
			const p = await presentError(refusal(code), i18n);
			expect([code, FALLBACKS.includes(p.message)]).toEqual([code, false]);
			expect(p.message).not.toMatch(/data processing agreement|—/);
		}
	});
});
