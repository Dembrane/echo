import { i18n } from "@lingui/core";
import { beforeAll, expect, it } from "vitest";
import { aiEventLines, historyLine, historyTitle } from "./AiProviderSection";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const enabled = {
	at: "2026-11-25T10:00:00Z",
	by: "Sam Example",
	job: "analysis" as const,
	kind: "enabled" as const,
	provider: "google" as const,
	request_at: "2026-11-24T09:00:00Z",
};

it("writes a history line as when and what, with the person after Show all", () => {
	expect(historyLine(enabled, "en-US")).toBe(
		"25 Nov 2026 · Google Vertex AI enabled for Analysis",
	);
	expect(historyLine(enabled, "en-US", true)).toBe(
		"25 Nov 2026 · Google Vertex AI enabled for Analysis · Sam Example",
	);
	expect(historyTitle(enabled, "en-US")).toBe(
		"Sam Example · Request of 24 Nov 2026",
	);
});

it("says on the timeline what an account change was, per job", () => {
	const detail = (before: object, after: object) => ({
		detail: { after, before },
		type: "ai_providers.changed",
	});
	const scaleway = {
		defaults: { analysis: "scaleway", transcription: "scaleway" },
		enabled: { analysis: ["scaleway"], transcription: ["scaleway"] },
	};
	expect(
		aiEventLines(
			detail(scaleway, {
				...scaleway,
				enabled: {
					analysis: ["scaleway", "google"],
					transcription: ["scaleway"],
				},
			}),
		),
	).toEqual(["Google Vertex AI enabled for Analysis"]);
	expect(
		aiEventLines(
			detail(
				{
					defaults: { analysis: "google", transcription: "scaleway" },
					enabled: {
						analysis: ["scaleway", "google"],
						transcription: ["scaleway", "google"],
					},
				},
				scaleway,
			),
		),
	).toEqual([
		"Google Vertex AI removed from Transcription",
		"Google Vertex AI removed from Analysis",
		"Scaleway is now the default for Analysis",
	]);
});

it("says on the timeline which project moved, and for which job", () => {
	const at = (after: string | null, project_name?: string) =>
		aiEventLines({
			detail: { after, before: null, job: "transcription", project_name },
			type: "project.ai_provider.changed",
		});
	expect(at("google", "Example town")).toEqual([
		"Project Example town moved to Google Vertex AI for Transcription",
	]);
	expect(at(null, "Example town")).toEqual([
		"Project Example town back on the account default for Transcription",
	]);
	expect(at("google")).toEqual([
		"A project moved to Google Vertex AI for Transcription",
	]);
});
