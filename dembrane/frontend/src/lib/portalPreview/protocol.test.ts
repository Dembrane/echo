import { describe, expect, it } from "vitest";
import { portalDefaults } from "@/components/project/portal-editor/portalForm";
import { buildPreviewMessage } from "@/components/project/portal-editor/preview/buildPreviewMessage";
import {
	isReadyMessage,
	originOf,
	PREVIEW_READY,
	parsePreviewMessage,
	webUrl,
} from "./protocol";

const values = portalDefaults({
	default_conversation_description: "**Hello** <img src=x onerror=alert(1)>",
	default_conversation_title: "The square",
	id: "p1",
	language: "nl",
} as unknown as Project);

const message = () =>
	buildPreviewMessage({
		highlight: "title",
		legal: {
			legal_basis: "consent",
			organiser_name: "Lindenwijk council",
			privacy_policy_url: "https://example.org/privacy",
		},
		screen: "recording",
		tags: [{ id: "t1", text: "Round 1" }],
		topics: {
			available_topics: [
				{
					is_custom: false,
					key: "agreements",
					translations: {
						"en-US": { label: "Table check" },
						"nl-NL": { label: "Tafelcheck" },
					},
				},
				{ is_custom: false, key: "heard", translations: {} },
			],
			selected_topics: ["agreements"],
		} as never,
		values: { ...values, verification_topics: ["agreements"] },
	});

// ECHO-1060: what the portal accepts from the dashboard, and nothing else.
describe("parsePreviewMessage", () => {
	it("accepts what the dashboard builds, unchanged", () => {
		const built = message();
		expect(parsePreviewMessage(built)).toEqual(built);
		expect(built.project.language).toBe("nl");
		// Topics in the portal's language, only the chosen ones.
		expect(built.topics).toEqual([{ key: "agreements", label: "Tafelcheck" }]);
	});

	it("keeps text as text: the parser passes it on, React escapes it", () => {
		expect(
			parsePreviewMessage(message())?.project.default_conversation_description,
		).toContain("<img");
	});

	it("refuses anything else", () => {
		const good = message();
		const bad: unknown[] = [
			null,
			"hello",
			{ ...good, type: "something-else" },
			{ ...good, version: 2 },
			{ ...good, screen: "admin" },
			{ ...good, highlight: "everything" },
			{ ...good, project: { ...good.project, language: "xx" } },
			{ ...good, project: { ...good.project, is_verify_enabled: "yes" } },
			{
				...good,
				project: {
					...good.project,
					default_conversation_title: "x".repeat(501),
				},
			},
			{
				...good,
				project: {
					...good.project,
					privacy_policy_url: "javascript:alert(1)",
				},
			},
			{ ...good, project: { ...good.project, tags: "t1" } },
			{ ...good, topics: [{ key: "", label: "x" }] },
			{ ...good, result: { key: "k", source: "server", text: "x" } },
		];
		for (const data of bad) expect(parsePreviewMessage(data)).toBeNull();
	});

	it("drops fields it does not know", () => {
		const parsed = parsePreviewMessage({
			...message(),
			extra: "<script>",
			project: { ...message().project, api_key: "secret" },
		});
		expect(parsed).not.toBeNull();
		expect(parsed && "extra" in parsed).toBe(false);
		expect(parsed && "api_key" in parsed.project).toBe(false);
	});

	it("knows the ready message and web addresses", () => {
		expect(isReadyMessage({ type: PREVIEW_READY })).toBe(true);
		expect(isReadyMessage({ type: "other" })).toBe(false);
		expect(originOf("https://portal.dembrane.com/en-US/p1")).toBe(
			"https://portal.dembrane.com",
		);
		expect(originOf("not a url")).toBeNull();
		expect(webUrl("https://example.org/p")).toBe("https://example.org/p");
		expect(webUrl("javascript:alert(1)")).toBeNull();
		expect(webUrl("https://")).toBeNull();
	});
});

describe("buildPreviewMessage", () => {
	it("shows the example for the open screen, and lets a real result through", () => {
		const explore = buildPreviewMessage({
			highlight: null,
			legal: null,
			screen: "explore",
			tags: [],
			topics: undefined,
			values: { ...values, get_reply_mode: "brainstorm", language: "en" },
		});
		expect(explore.result?.source).toBe("example");
		expect(explore.result?.text).toContain("What if");
		const verify = buildPreviewMessage({
			highlight: null,
			legal: null,
			screen: "verify-summary",
			tags: [],
			topics: undefined,
			values: { ...values, language: "nl" },
		});
		expect(
			verify.result?.text.startsWith("Concept om samen te verbeteren."),
		).toBe(true);
		expect(
			verify.result?.text.endsWith(
				"Klopt dit? Wat ontbreekt of is te stellig?",
			),
		).toBe(true);
		const real = buildPreviewMessage({
			highlight: null,
			legal: null,
			result: { key: "summarize", source: "model", text: "A real reply" },
			screen: "explore",
			tags: [],
			topics: undefined,
			values,
		});
		expect(real.result).toEqual({
			key: "summarize",
			source: "model",
			text: "A real reply",
		});
		// Other screens carry no result.
		expect(message().result).toBeNull();
	});

	it("falls back to the client-managed basis and drops a policy link that is not a web address", () => {
		const built = buildPreviewMessage({
			highlight: null,
			legal: {
				legal_basis: "unknown",
				organiser_name: null,
				privacy_policy_url: "ftp://x",
			},
			screen: "privacy",
			tags: [],
			topics: undefined,
			values,
		});
		expect(built.project.legal_basis).toBe("client-managed");
		expect(built.project.privacy_policy_url).toBeNull();
		expect(parsePreviewMessage(built)).not.toBeNull();
	});
});
