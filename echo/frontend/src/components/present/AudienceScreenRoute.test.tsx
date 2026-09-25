// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { bff } from "@/lib/bff";
import { AudienceScreenRoute } from "./AudienceScreen";

vi.mock("@/lib/bff", () => ({
	bff: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
}));
vi.mock("@/hooks/useServerEvents", () => ({ useServerEvents: vi.fn() }));
vi.mock("@/components/common/QRCode", () => ({ QRCode: () => null }));
vi.mock("./AudienceMapAdapter", () => ({ AudienceMapAdapter: () => null }));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia = vi.fn().mockImplementation((media) => ({
		addEventListener() {},
		matches: false,
		media,
		removeEventListener() {},
	}));
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

/**
 * The room screen is for showing. Its opening slides are reworded in the
 * dashboard's preview, so the route asks for no draft and hands the deck no
 * way to edit: without `onEditOpening` the deck never hears "editing".
 */
it("never asks for the draft the editing affordance needed", async () => {
	// The audience read goes out over fetch; the draft was the one thing the
	// route asked bff for.
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			json: async () => ({
				bundle: { files: { "session.json": { ui_language: "en" } } },
				id: "p",
				manifest: { blocks: ["popcorn"], opening: "popcorn", version: 1 },
			}),
			ok: true,
			status: 200,
		}),
	);
	const post = vi.spyOn(window, "postMessage");
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={["/present/screen/p"]}>
						<Routes>
							<Route
								path="/present/screen/:presentationId"
								element={<AudienceScreenRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);
	await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
	expect(bff.get).not.toHaveBeenCalled();
	expect(
		post.mock.calls.some(
			([message]) =>
				(message as { command?: string } | null)?.command === "editing",
		),
	).toBe(false);
});
