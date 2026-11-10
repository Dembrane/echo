// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SUGGESTIONS } from "../setupSuggestions.fixture";
import { Providers, setUpDom } from "../testing";
import {
	SessionBriefConnected,
	type SettingOverrides,
} from "./SessionBriefConnected";

const tracked = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/events", async (orig) => ({
	...(await orig<typeof import("@/lib/analytics/events")>()),
	track: tracked,
}));

afterEach(() => {
	cleanup();
	tracked.mockReset();
	vi.unstubAllGlobals();
});
beforeAll(setUpDom);

const answer = (status: number, body: unknown) =>
	vi.fn(async () => new Response(JSON.stringify(body), { status }));

let latest: { keyTerms: string; overrides: SettingOverrides } = {
	keyTerms: "",
	overrides: {},
};
const Harness = ({
	initialTerms = "",
	description = "Over het warmtenet, met Woonbedrijf",
}: {
	initialTerms?: string;
	description?: string;
}) => {
	const [keyTerms, setKeyTerms] = useState(initialTerms);
	const [overrides, setOverrides] = useState<SettingOverrides>({});
	latest = { keyTerms, overrides };
	return (
		<SessionBriefConnected
			workspaceId="w1"
			templateKey="event"
			name="Bewonersavond"
			description={description}
			language="nl"
			keyTerms={keyTerms}
			onKeyTermsChange={setKeyTerms}
			overrides={overrides}
			onOverridesChange={setOverrides}
		/>
	);
};
const renderConnected = (initialTerms?: string, description?: string) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<Providers>
				<Harness initialTerms={initialTerms} description={description} />
			</Providers>
		</QueryClientProvider>,
	);

describe("SessionBriefConnected", () => {
	it("sends the project context and the terms the host has, and tracks counts only", async () => {
		const fetchMock = answer(200, SUGGESTIONS);
		vi.stubGlobal("fetch", fetchMock);
		renderConnected("GGD");
		fireEvent.click(screen.getByRole("button", { name: "Suggest key terms" }));
		await screen.findByTestId("setup-suggestions-results");
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toContain("/v2/workspaces/w1/project-setup/suggestions");
		expect(JSON.parse(String(init.body))).toEqual({
			description: "Over het warmtenet, met Woonbedrijf",
			existing_key_terms: ["GGD"],
			language: "nl",
			name: "Bewonersavond",
			source_url: null,
			template_key: "event",
		});
		expect(tracked).toHaveBeenCalledWith("project_setup_ai_suggested", {
			has_text: true,
			has_url: false,
			settings_proposed: 2,
			surface: "wizard",
			template_key: "event",
			terms_proposed: 5,
		});
		expect(JSON.stringify(tracked.mock.calls)).not.toContain("Woonbedrijf");
	});

	it("accepting puts terms in the key terms value; removing takes a proposal away", async () => {
		vi.stubGlobal("fetch", answer(200, SUGGESTIONS));
		renderConnected("GGD");
		fireEvent.click(screen.getByRole("button", { name: "Suggest key terms" }));
		await screen.findByTestId("setup-suggestions-results");
		fireEvent.click(screen.getByRole("button", { name: "Strijp-S" }));
		expect(latest.keyTerms).toBe("GGD, Strijp-S");
		fireEvent.click(screen.getByRole("button", { name: "Strijp-S" }));
		expect(latest.keyTerms).toBe("GGD");
		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove Woonbedrijf from the suggestions",
			}),
		);
		expect(screen.queryByRole("button", { name: "Woonbedrijf" })).toBeNull();
		fireEvent.click(screen.getByTestId("setup-suggestions-accept-all"));
		expect(latest.keyTerms).toBe(
			"GGD, Marieke de Wolf, Strijp-S, Ennatuurlijk, VvE Strijp-R",
		);
	});

	it("a ticked setting becomes an override with the proposed value", async () => {
		vi.stubGlobal("fetch", answer(200, SUGGESTIONS));
		renderConnected();
		fireEvent.click(screen.getByRole("button", { name: "Suggest key terms" }));
		await screen.findByTestId("setup-suggestions-results");
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Ask participants for their name" }),
		);
		expect(latest.overrides).toEqual({
			default_conversation_ask_for_participant_name: true,
		});
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Ask participants for their name" }),
		);
		expect(latest.overrides).toEqual({});
	});

	it("a paste longer than a request reads: the first 20,000 characters are sent, and the host is told", async () => {
		const fetchMock = answer(200, SUGGESTIONS);
		vi.stubGlobal("fetch", fetchMock);
		const long = `Agenda ${"Strijp-S ".repeat(3_000)}`;
		renderConnected("", long);
		fireEvent.click(screen.getByRole("button", { name: "Suggest key terms" }));
		await screen.findByTestId("setup-suggestions-results");
		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		const sent = JSON.parse(String(init.body)).description as string;
		expect(long.length).toBeGreaterThan(20_000);
		expect(sent).toBe(long.trim().slice(0, 20_000));
		expect(
			screen.getByTestId("setup-suggestions-long-note").textContent,
		).toContain("The whole text is saved.");
	});

	it("with no context and no link, the action waits and says to describe the session", () => {
		renderConnected("", "");
		expect(
			screen.getByTestId("setup-suggestions-submit").hasAttribute("disabled"),
		).toBe(true);
		expect(screen.getByTestId("setup-suggestions-hint").textContent).toContain(
			"Describe your session in the project context",
		);
		fireEvent.click(screen.getByRole("button", { name: "Add a link" }));
		fireEvent.change(screen.getByLabelText(/Link to a page about it/), {
			target: { value: "https://example.org/avond" },
		});
		expect(
			screen.getByTestId("setup-suggestions-submit").hasAttribute("disabled"),
		).toBe(false);
	});

	it.each([
		[402, "budget"],
		[503, "unavailable"],
		[429, "rate_limited"],
	])("a %s shows the quiet line and tracks %s", async (status, cause) => {
		vi.stubGlobal("fetch", answer(status, { code: "x" }));
		renderConnected();
		fireEvent.click(screen.getByRole("button", { name: "Suggest key terms" }));
		await screen.findByTestId("setup-suggestions-error");
		await waitFor(() =>
			expect(tracked).toHaveBeenCalledWith("project_setup_ai_failed", {
				cause,
				surface: "wizard",
			}),
		);
	});
});
