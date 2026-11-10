// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SUGGESTIONS } from "../setupSuggestions.fixture";
import { Providers, setUpDom } from "../testing";
import { SuggestKeyTermsConnected } from "./SuggestKeyTermsConnected";

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

let value = "";
const Harness = () => {
	const [v, setV] = useState("Klokgebouw");
	value = v;
	return (
		<SuggestKeyTermsConnected
			project={{
				context: "Bewonersavond over het warmtenet",
				language: "nl",
				name: "Strijp-S",
				workspace_id: "w1",
			}}
			value={v}
			onChange={setV}
		/>
	);
};

describe("SuggestKeyTermsConnected (portal editor)", () => {
	it("asks from the project itself, key terms only, and adds what the host accepts", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ ...SUGGESTIONS, settings: [] })),
		);
		vi.stubGlobal("fetch", fetchMock);
		render(
			<QueryClientProvider client={new QueryClient()}>
				<Providers>
					<Harness />
				</Providers>
			</QueryClientProvider>,
		);
		expect(screen.queryByLabelText("About your session")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Suggest key terms" }));
		await screen.findByTestId("setup-suggestions-results");
		const init = (
			fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		)[1];
		expect(JSON.parse(String(init.body))).toEqual({
			description: "Bewonersavond over het warmtenet",
			existing_key_terms: ["Klokgebouw"],
			include_settings: false,
			language: "nl",
			name: "Strijp-S",
			template_key: "blank",
		});
		fireEvent.click(screen.getByRole("button", { name: "Woonbedrijf" }));
		expect(value).toBe("Klokgebouw, Woonbedrijf");
		expect(tracked).toHaveBeenCalledWith("project_setup_ai_accepted", {
			settings_accepted: 0,
			surface: "portal_editor",
			terms_accepted: 1,
		});
		fireEvent.click(screen.getByTestId("setup-suggestions-accept-all"));
		expect(tracked).toHaveBeenLastCalledWith("project_setup_ai_accepted", {
			settings_accepted: 0,
			surface: "portal_editor",
			terms_accepted: 4,
		});
	});
});
