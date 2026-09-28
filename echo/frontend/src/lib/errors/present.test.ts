import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { loadErrorMessages, presentError, presentErrorNow } from "./present";
import { ApiRequestError, readApiError } from "./read";

const axiosError = (status: number, data: unknown) => ({
	isAxiosError: true,
	message: `Request failed with status code ${status}`,
	response: { data, status },
});

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

describe("readApiError", () => {
	it("reads code, params, action and fields from an axios error", () => {
		const info = readApiError(
			axiosError(422, {
				action: "fix_input",
				code: "validation.invalid_input",
				detail: [{ loc: ["body", "name"], msg: "Field required" }],
				params: {
					fields: [
						{
							code: "field.required",
							field: "name",
							loc: ["body", "name"],
							params: {},
						},
					],
				},
			}),
		);
		expect(info).toMatchObject({
			action: "fix_input",
			code: "validation.invalid_input",
			network: false,
			status: 422,
		});
		expect(info.fields).toEqual([
			{ code: "field.required", field: "name", params: {} },
		]);
	});

	it("reads a bff ApiRequestError and a network failure", () => {
		const bff = new ApiRequestError(404, {
			action: "none",
			code: "project.not_found",
			detail: "Project not found",
			params: {},
		});
		expect(readApiError(bff)).toMatchObject({
			code: "project.not_found",
			status: 404,
		});
		expect(readApiError(new TypeError("Failed to fetch")).network).toBe(true);
	});
});

describe("presentError", () => {
	it("says a known code in friendly words with the API's action", async () => {
		const p = await presentError(
			axiosError(413, {
				action: "fix_input",
				code: "upload.too_large",
				detail: "The file is larger than 20 MB",
				params: { max_mb: 20 },
			}),
			i18n,
		);
		expect(p.message).toBe(
			"This file is too large. Files can be at most 20 MB.",
		);
		expect(p.action).toBe("fix_input");
	});

	it("never shows backend text for an unknown code or a body without one", async () => {
		await loadErrorMessages(i18n);
		for (const body of [
			{
				action: "retry",
				code: "nobody.knows_this",
				detail: "secret stack",
				params: {},
			},
			{ detail: "Raw backend sentence" },
			"<html>502 Bad Gateway</html>",
		]) {
			const p = presentErrorNow(axiosError(500, body), i18n);
			expect(p.message).not.toContain("secret");
			expect(p.message).not.toContain("Raw backend");
			expect(p.action).toBe("contact_support");
		}
	});

	it("gives validation fields their own messages and names the admin", async () => {
		const fields = await presentError(
			axiosError(422, {
				action: "fix_input",
				code: "validation.invalid_input",
				detail: [],
				params: {
					fields: [
						{
							code: "field.too_short",
							field: "name",
							params: { min_length: 3 },
						},
					],
				},
			}),
			i18n,
		);
		expect(fields.fields).toEqual({ name: "Use at least 3 characters." });
		const admin = await presentError(
			axiosError(403, {
				action: "contact_admin",
				code: "access.forbidden",
				detail: "Not allowed",
				params: { admin_email: "ada@example.org", admin_name: "Ada" },
			}),
			i18n,
		);
		expect(admin.admin).toEqual({ email: "ada@example.org", name: "Ada" });
	});

	it("reports no connection as a retry", async () => {
		const p = await presentError(new TypeError("Failed to fetch"), i18n);
		expect(p.action).toBe("retry");
		expect(p.message).toContain("internet connection");
	});
});
