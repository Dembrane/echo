// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { PageBox } from "../pdf/PdfPages";
import { FieldEditorRoute } from "./FieldEditorRoute";

// Staff place signing fields on a draft PDF: drag them into place, save, send.
const call = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const notifyError = vi.hoisted(() => vi.fn());
vi.mock("../api/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/client")>()),
	call,
}));
vi.mock("../api/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/hooks")>()),
	useDocument: () => ({
		data: {
			file_url: "/doc.pdf",
			page_count: 1,
			sha256: "abc",
			status: "draft",
			title: "Offer 2026",
		},
		isLoading: false,
	}),
	usePdfData: () => ({ data: new Uint8Array([1]) }),
}));
// One 600 x 800 page, with the editor's fields laid over it.
vi.mock("../pdf/PdfPages", () => ({
	PdfPages: ({ overlay }: { overlay: (box: PageBox) => ReactNode }) => (
		<div>{overlay({ height: 800, page: 1, width: 600 } as PageBox)}</div>
	),
}));
vi.mock("../i18n", () => ({
	AccountsI18n: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./AccountCardRoute", () => ({
	StaffOnly: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/components/common/Toaster", () => ({
	toast: { success: toastSuccess },
}));
vi.mock("@/components/error/notifyError", () => ({ notifyError }));

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
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
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	// jsdom has no pointer events: a mouse event carries the coordinates.
	window.PointerEvent ??= MouseEvent as unknown as typeof PointerEvent;
	Element.prototype.setPointerCapture ??= () => {};
});
afterEach(() => {
	cleanup();
	call.mockReset();
	navigate.mockReset();
	toastSuccess.mockReset();
	notifyError.mockReset();
});

const savedField = (id: string, kind: string, x: number) => ({
	height: 0.05,
	id,
	key: null,
	kind,
	label: kind,
	page: 1,
	required: true,
	width: 0.2,
	x,
	y: 0.5,
});
const saved = {
	fields: [
		savedField("f-sig", "signature", 0.1),
		savedField("f-name", "name", 0.5),
	],
	page_count: 1,
};

const show = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter initialEntries={["/admin/accounts/org/doc/fields"]}>
						<Routes>
							<Route
								path="/admin/accounts/:orgId/:docId/fields"
								element={<FieldEditorRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

const answer = (routes: Record<string, unknown>) =>
	call.mockImplementation(async (name: string) => {
		if (name in routes) {
			const r = routes[name];
			if (r instanceof Error) throw r;
			return r;
		}
		throw new Error(`unexpected ${name}`);
	});

it("shows the saved fields once they load", async () => {
	answer({ staffDocumentFields: saved });
	show();
	expect(await screen.findAllByTestId("placed-field")).toHaveLength(2);
	expect(screen.getByTestId("fields-save")).toHaveProperty("disabled", true);
});

it("moves a dragged field, and saves where it went", async () => {
	answer({ setDocumentFields: saved, staffDocumentFields: saved });
	show();
	const [signature] = await screen.findAllByTestId("placed-field");
	fireEvent.pointerDown(signature, { clientX: 100, clientY: 100 });
	fireEvent.pointerMove(signature, { clientX: 160, clientY: 100 });
	fireEvent.pointerUp(signature);

	fireEvent.click(screen.getByTestId("fields-save"));
	await waitFor(() =>
		expect(toastSuccess).toHaveBeenCalledWith("Fields saved"),
	);
	const body = call.mock.calls.find(([n]) => n === "setDocumentFields")?.[1]
		.body;
	// 60 px across a 600 px page is a tenth of its width
	expect(body.fields[0].x).toBeCloseTo(0.2);
	expect(screen.getByTestId("fields-save")).toHaveProperty("disabled", true);
});

it("keeps the changes to save again when saving fails", async () => {
	answer({
		setDocumentFields: new Error("refused"),
		staffDocumentFields: saved,
	});
	show();
	const [signature] = await screen.findAllByTestId("placed-field");
	fireEvent.pointerDown(signature, { clientX: 100, clientY: 100 });
	fireEvent.pointerMove(signature, { clientX: 130, clientY: 100 });
	fireEvent.pointerUp(signature);
	fireEvent.click(screen.getByTestId("fields-save"));

	await waitFor(() => expect(notifyError).toHaveBeenCalled());
	await waitFor(() =>
		expect(screen.getByTestId("fields-save")).toHaveProperty("disabled", false),
	);
});

it("sends the document to sign and goes back to the account", async () => {
	answer({ sendDocument: {}, staffDocumentFields: saved });
	show();
	await screen.findAllByTestId("placed-field");
	fireEvent.click(screen.getByTestId("fields-send"));
	await waitFor(() =>
		expect(navigate).toHaveBeenCalledWith("/admin/accounts/org"),
	);
	expect(toastSuccess).toHaveBeenCalledWith(
		"Sent. The customer has a signing task.",
	);
});
