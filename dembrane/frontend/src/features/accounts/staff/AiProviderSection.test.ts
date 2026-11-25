import { i18n } from "@lingui/core";
import { beforeAll, expect, it } from "vitest";
import { aiEventLines, historyLine, historyTitle } from "./AiProviderSection";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const added = {
	at: "2026-11-25T10:00:00Z",
	by: "Sam Example",
	kind: "added" as const,
	provider: "google" as const,
	request_at: "2026-11-24T09:00:00Z",
};

it("writes a history line as what and when, with the person after Show all", () => {
	expect(historyLine(added, "en-US")).toBe(
		"Google Vertex AI added · 25 Nov 2026",
	);
	expect(historyLine(added, "en-US", true)).toBe(
		"Google Vertex AI added · 25 Nov 2026 · Sam Example",
	);
	expect(historyTitle(added, "en-US")).toBe(
		"Sam Example · Request of 24 Nov 2026",
	);
});

it("says on the timeline what an account change was", () => {
	const detail = (before: object, after: object) => ({
		detail: { after, before },
		type: "ai_providers.changed",
	});
	expect(
		aiEventLines(
			detail(
				{ allowed: ["scaleway"], default: "scaleway" },
				{ allowed: ["scaleway", "google"], default: "scaleway" },
			),
		),
	).toEqual(["Google Vertex AI added"]);
	expect(
		aiEventLines(
			detail(
				{ allowed: ["scaleway", "google"], default: "google" },
				{ allowed: ["scaleway"], default: "scaleway" },
			),
		),
	).toEqual(["Google Vertex AI removed", "Default changed to Scaleway"]);
});

it("says on the timeline which project moved", () => {
	const at = (after: string | null, project_name?: string) =>
		aiEventLines({
			detail: { after, before: null, project_name },
			type: "project.ai_provider.changed",
		});
	expect(at("google", "Example town")).toEqual([
		"Project Example town moved to Google Vertex AI",
	]);
	expect(at(null, "Example town")).toEqual([
		"Project Example town back on the account default",
	]);
	expect(at("google")).toEqual(["A project moved to Google Vertex AI"]);
});
