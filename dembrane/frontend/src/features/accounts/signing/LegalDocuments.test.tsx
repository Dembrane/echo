// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { offerDetail } from "../contract/fixtures.gen";
import { LegalDocuments } from "./SignRoute";

// Above Sign: the documents the agreement is made of, each opening the version the offer
// pinned. The pages are drawn on a canvas, so the links printed in them do nothing.
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
});
afterEach(cleanup);

const show = (doc: Parameters<typeof LegalDocuments>[0]["doc"]) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<LegalDocuments doc={doc} />
			</MantineProvider>
		</I18nProvider>,
	);

describe("documents that form the agreement", () => {
	it("links the pinned terms, SLA and DPA of an offer, each with its version", () => {
		show(offerDetail);
		expect(screen.getByText("Documents that form the agreement")).toBeTruthy();
		for (const pin of offerDetail.legal) {
			const link = screen.getByTestId(
				`sign-document-${pin.kind}`,
			) as HTMLAnchorElement;
			expect(link.href).toContain(
				`/documents/${offerDetail.id}/legal/${pin.kind}`,
			);
			expect(link.href).not.toContain("dembrane.com/legal");
			expect(link.target).toBe("_blank");
			expect(link.textContent).toContain(`(${pin.version})`);
		}
		expect(screen.getByTestId("sign-document-terms").textContent).toContain(
			"General terms and conditions",
		);
	});

	it("shows nothing on the DPA itself or when nothing is pinned", () => {
		show({ ...offerDetail, kind: "dpa" });
		expect(screen.queryByTestId("sign-documents")).toBeNull();
		cleanup();
		show({ ...offerDetail, legal: [] });
		expect(screen.queryByTestId("sign-documents")).toBeNull();
	});
});
