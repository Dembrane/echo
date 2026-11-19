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
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fx from "../contract/fixtures.gen";

// The who-signs task, chosen one line per document from the room's people: it sends the
// answerWhoSigns body the server expects.
const calls: { name: string; options: unknown }[] = [];
/** The account page the dialog reads; null: the fixture as it is. */
let page: unknown = null;
vi.mock("../api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../api/client")>();
	return {
		...actual,
		call: vi.fn(async (name: string, options: unknown) => {
			calls.push({ name, options });
			if (name === "roomPage") return fx.roomPage;
			if (name === "accountPage") return page ?? fx.accountPage;
			return {};
		}),
	};
});

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
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			json: async () => ({ email: "robin@example-town.example" }),
			ok: true,
		})),
	);
});
afterEach(() => {
	cleanup();
	calls.length = 0;
	page = null;
});

const task = fx.accountPage.tasks.find((t) => t.code === "who_signs");
const orgId = fx.accountPage.organisation.id;

const show = async () => {
	const { WhoSigns } = await import("./WhoSigns");
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter>
						<WhoSigns orgId={orgId} task={task ?? null} onClose={vi.fn()} />
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	await screen.findByTestId("signer-row-offer");
	await waitFor(() =>
		expect(calls.some((c) => c.name === "accountPage")).toBe(true),
	);
};

const pick = async (kind: "offer" | "dpa", name: RegExp) => {
	fireEvent.click(screen.getByTestId(`signer-choose-${kind}`));
	const items = await screen.findAllByTestId("signer-candidate");
	const item = items.find((i) => name.test(i.textContent ?? ""));
	fireEvent.click(item as HTMLElement);
};

const finish = async () => {
	fireEvent.click(screen.getByTestId("who-signs-next"));
	fireEvent.click(await screen.findByTestId("dpia-no"));
	fireEvent.click(screen.getByTestId("who-signs-next"));
	await waitFor(() =>
		expect(calls.some((c) => c.name === "answerWhoSigns")).toBe(true),
	);
	return calls.find((c) => c.name === "answerWhoSigns")?.options as {
		body: unknown;
	};
};

describe("who signs", () => {
	it("is a task in the fixtures", () => {
		expect(task).toBeTruthy();
	});

	it("sends 'I sign both' as before", async () => {
		await show();
		await pick("offer", /\(you\)/);
		const sent = await finish();
		expect(sent.body).toEqual({
			dpa_same: true,
			dpa_signer: null,
			dpia: false,
			offer_signer: null,
		});
	});

	it("names someone from the room to sign the offer, the DPA with it", async () => {
		await show();
		await pick("offer", /Sam Example/);
		const sent = await finish();
		expect(sent.body).toEqual({
			dpa_same: true,
			dpa_signer: null,
			dpia: false,
			offer_signer: {
				email: "sam@example-town.example",
				name: "Sam Example",
				role: null,
			},
		});
	});

	it("names a different person for the DPA", async () => {
		await show();
		await pick("offer", /\(you\)/);
		await pick("dpa", /Sam Example/);
		const sent = await finish();
		expect(sent.body).toEqual({
			dpa_same: false,
			dpa_signer: {
				email: "sam@example-town.example",
				name: "Sam Example",
				role: null,
			},
			dpia: false,
			offer_signer: null,
		});
	});

	describe("with someone named already", () => {
		const ANTOINE = {
			email: "antoine@example-town.example",
			name: "Antoine Burgers",
			role: "Alderman",
		};
		/** The offer named to Antoine; `mayName` false is how Billing sees it. */
		const named = (mayName = true) => {
			page = {
				...fx.accountPage,
				documents: fx.accountPage.documents.map((d) => ({
					...d,
					may_name_signer: mayName,
					...(d.id === task?.document_id && {
						signer: {
							...ANTOINE,
							named_at: "2026-09-28T09:00:00.000Z",
							reminded_at: null,
						},
					}),
				})),
			};
		};

		it("starts from the person named, and keeping them sends them as they are", async () => {
			named();
			await show();
			await waitFor(() =>
				expect(screen.getByTestId("signer-row-offer").textContent).toContain(
					"Antoine Burgers · antoine@example-town.example",
				),
			);
			expect(screen.getByTestId("signer-row-dpa").textContent).toContain(
				"Nobody yet",
			);
			await pick("dpa", /\(you\)/);
			const sent = await finish();
			expect(sent.body).toEqual({
				dpa_same: false,
				dpa_signer: null,
				dpia: false,
				offer_signer: ANTOINE,
			});
		});

		it("signing yourself in their place says their link stops working first", async () => {
			named();
			await show();
			await waitFor(() =>
				expect(screen.getByTestId("signer-row-offer").textContent).toContain(
					"Antoine Burgers",
				),
			);
			await pick("offer", /\(you\)/);
			expect(screen.getByTestId("signer-replaces-offer").textContent).toBe(
				"Antoine Burgers no longer signs the offer, and the link we sent them stops working.",
			);
			const sent = await finish();
			expect(sent.body).toEqual({
				dpa_same: true,
				dpa_signer: null,
				dpia: false,
				offer_signer: null,
			});
		});

		it("Billing sees who signs the offer and cannot change it; the DPA stays theirs to answer", async () => {
			named(false);
			await show();
			await waitFor(() =>
				expect(screen.getByTestId("signer-row-offer").textContent).toContain(
					"Antoine Burgers",
				),
			);
			expect(screen.queryByTestId("signer-choose-offer")).toBeNull();
			await pick("dpa", /\(you\)/);
			const sent = await finish();
			expect(sent.body).toEqual({
				dpa_same: false,
				dpa_signer: null,
				dpia: false,
				offer_signer: ANTOINE,
			});
		});
	});
});
