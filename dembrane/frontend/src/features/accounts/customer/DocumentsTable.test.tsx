// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DocumentSummaryT } from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";

// The documents list for those who run the account and for a room member, with the share
// shortcut: access (default "account"), signing (the documents the room says the person
// looking signs) and onShare.
import { DocumentsTable } from "./DocumentsTable";

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia ??= ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const ORG = fx.accountPage.organisation.id;
const docs = fx.accountPage.documents;
const offer = docs.find((d) => d.kind === "offer") as DocumentSummaryT;
const dpa = docs.find((d) => d.kind === "dpa") as DocumentSummaryT;

type Props = Parameters<typeof DocumentsTable>[0];
const Table = DocumentsTable;

const show = (props: Omit<Props, "orgId">) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<MemoryRouter initialEntries={[`/en-US/o/${ORG}/documents`]}>
					<Routes>
						<Route
							path="/:language/o/:organisationId/documents"
							element={<Table orgId={ORG} title={null} {...props} />}
						/>
					</Routes>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

const row = (kind: string) => screen.getByTestId(`doc-${kind}`);

describe("the documents, for a room member", () => {
	const roomDocs = [
		{ ...offer, may_download: false },
		{ ...dpa, may_download: true },
	];

	it("opens the offer to read, with no signing and no download while it may not be saved", () => {
		show({ access: "room", documents: roomDocs });
		const o = row("offer");
		expect(within(o).queryByTestId("doc-sign")).toBeNull();
		expect(within(o).queryByTestId("doc-pdf")).toBeNull();
		const read = within(o).getByTestId("doc-read");
		expect(read.getAttribute("href")).toContain(
			`/o/${ORG}/account/documents/${offer.id}/sign`,
		);
	});

	it("opens a document they are named to sign, as the room says, to sign", () => {
		show({ access: "room", documents: roomDocs, signing: [offer.id] });
		expect(within(row("offer")).getByTestId("doc-sign")).toBeTruthy();
		expect(within(row("offer")).queryByTestId("doc-read")).toBeNull();
	});

	it("lets them download a signed copy, as the server allows", () => {
		show({ access: "room", documents: roomDocs });
		expect(within(row("dpa")).getByTestId("doc-pdf")).toBeTruthy();
	});
});

describe("the documents, for those who run the account", () => {
	it("still opens an unsigned offer to sign", () => {
		show({ documents: docs });
		expect(within(row("offer")).getByTestId("doc-sign")).toBeTruthy();
	});

	it("never offers a download the server says may not be made", () => {
		show({
			documents: [{ ...dpa, may_download: false }],
		});
		expect(within(row("dpa")).queryByTestId("doc-pdf")).toBeNull();
	});
});

describe("the DPA's kind label", () => {
	it("is the one kind that carries the tooltip spelling DPA out", () => {
		show({ documents: docs });
		expect(within(row("dpa")).getByTestId("doc-kind").textContent).toBe("DPA");
		expect(within(row("offer")).queryByTestId("doc-kind")).toBeNull();
	});
});

describe("the share shortcut", () => {
	it("sits on the offer and the DPA, which the room holds, and opens the add flow", () => {
		const onShare = vi.fn();
		show({ documents: docs, onShare });
		for (const d of docs)
			expect(within(row(d.kind)).queryByTestId("doc-share") !== null).toBe(
				d.kind === "offer" || d.kind === "dpa",
			);
		expect(docs.some((d) => d.kind === "invoice")).toBe(true);
		fireEvent.click(within(row("offer")).getByTestId("doc-share"));
		expect(onShare).toHaveBeenCalledWith(
			expect.objectContaining({ id: offer.id }),
		);
	});

	it("is absent where nobody can add someone", () => {
		show({ documents: docs });
		expect(screen.queryByTestId("doc-share")).toBeNull();
	});
});
