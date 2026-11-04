import { i18n } from "@lingui/core";
import { beforeAll, expect, it } from "vitest";
import { reportErrorText } from "./reportError";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

it("translates a run the AI budget ended, whatever English the server stored", () => {
	expect(
		reportErrorText({
			error_code: "AI_BUDGET_USED_UP",
			error_message: "stored english",
		}),
	).toBe("This month's AI budget is used up.");
});

it("keeps any other stored message, and gives null when there is none", () => {
	expect(
		reportErrorText({ error_code: "OTHER", error_message: "Model failed" }),
	).toBe("Model failed");
	expect(reportErrorText({ error_code: null, error_message: null })).toBeNull();
	expect(reportErrorText({ error_message: "No code" })).toBe("No code");
});
