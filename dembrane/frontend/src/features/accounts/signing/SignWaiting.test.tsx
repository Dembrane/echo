// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { offerDetail } from "../contract/fixtures.gen";

// A member opens a document someone else was named to sign: the page waits on them and
// says how long ago they were named. The API is stood in for.
const served = vi.hoisted(() => ({ namedAt: "" }));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => ({
		data: { display_name: "Ada", email: "ada@example.org", id: "app-1" },
		isLoading: false,
	}),
}));
vi.mock("../i18n", () => ({
	AccountsI18n: ({ children }: { children: React.ReactNode }) => children,
	useAccountsCatalog: () => true,
}));
vi.mock("../api/client", async (importOriginal) => {
	const real = await importOriginal<typeof import("../api/client")>();
	return {
		...real,
		call: async (name: string) =>
			name === "readDocument"
				? {
						...offerDetail,
						access: "member",
						awaiting_signatures: [],
						signatures: [],
						signer: {
							email: "alex@example-town.example",
							name: "Alex Example",
							named_at: served.namedAt,
							reminded_at: null,
							role: null,
						},
						status: "viewed",
					}
				: {},
		fetchPdf: () => new Promise(() => {}),
	};
});

import { SignRoute } from "./SignRoute";

const ORG = "0199a1bd-0000-7000-8000-000000000001";
const SIGN = `/en-US/o/${ORG}/account/documents/${offerDetail.id}/sign`;
const NOW = new Date("2026-10-10T12:00:00Z");

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia = ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		matches: false,
		media: query,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
	window.scrollTo = () => {};
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const openNamedAt = (namedAt: string) => {
	served.namedAt = namedAt;
	vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter initialEntries={[SIGN]}>
						<Routes>
							<Route
								path="/:language/o/:organisationId/account/documents/:docId/sign"
								element={<SignRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
};

describe("waiting on the named signer", () => {
	it("says how many days ago they were named", async () => {
		openNamedAt("2026-10-07T09:00:00Z");
		const line = await screen.findByTestId("sign-waiting-on");
		expect(line.textContent).toContain("Waiting on Alex Example");
		expect(line.textContent).toContain("3 days");
	});

	it("says sent today within the first day", async () => {
		openNamedAt("2026-10-10T08:00:00Z");
		const line = await screen.findByTestId("sign-waiting-on");
		expect(line.textContent).toContain("sent today");
	});
});
