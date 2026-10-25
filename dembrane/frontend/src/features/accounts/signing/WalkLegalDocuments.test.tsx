// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The agreement is made of the terms and the SLA, so they have to open while the signer is
// still reading, not only once everything is filled in. The file, the pages and the
// session are stood in for; the walk and its panel are real.
vi.mock("@posthog/react", () => ({ usePostHog: () => undefined }));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => ({ data: undefined }) }));
vi.mock("../pdf/PdfPages", () => ({ PdfPages: () => <div /> }));
vi.mock("../api/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/hooks")>()),
	useLegalHref: (pin: { text_url?: string | null }) => pin.text_url ?? null,
	usePdfData: () => ({ data: new Uint8Array([1]), isError: false }),
	usePdfHref: () => null,
}));

import { offerDetail } from "../contract/fixtures.gen";
import { Walk } from "./SignRoute";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const walk = (doc: typeof offerDetail) =>
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={new QueryClient()}>
				<MantineProvider>
					<MemoryRouter>
						<Walk doc={doc} orgId="org-1" />
					</MemoryRouter>
				</MantineProvider>
			</QueryClientProvider>
		</I18nProvider>,
	);

describe("terms while signing", () => {
	it("links the terms and SLA on the first step, once", () => {
		walk(offerDetail);
		expect(screen.getByTestId("sign-start")).toBeTruthy();
		expect(screen.getAllByTestId("sign-documents")).toHaveLength(1);
		for (const kind of ["terms", "sla"]) {
			const link = screen.getByTestId(
				`sign-document-${kind}`,
			) as HTMLAnchorElement;
			expect(link.href).toContain(`/legal/${kind}`);
		}
	});

	it("keeps them one screen at a time when the walk moves on", () => {
		walk(offerDetail);
		fireEvent.click(screen.getByTestId("sign-start"));
		expect(screen.getAllByTestId("sign-documents")).toHaveLength(1);
	});

	it("shows nothing on a data processing agreement", () => {
		walk({ ...offerDetail, kind: "dpa" });
		expect(screen.queryByTestId("sign-documents")).toBeNull();
	});
});
