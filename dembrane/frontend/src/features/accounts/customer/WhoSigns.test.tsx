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
import { WhoSigns } from "./WhoSigns";

// The who-signs task, chosen one line per document from the room's people: it sends the
// answerWhoSigns body the server expects.
const calls: { name: string; options: unknown }[] = [];
vi.mock("../api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../api/client")>();
	return {
		...actual,
		call: vi.fn(async (name: string, options: unknown) => {
			calls.push({ name, options });
			if (name === "roomPage") return fx.roomPage;
			if (name === "accountPage") return fx.accountPage;
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
});

const task = fx.accountPage.tasks.find((t) => t.code === "who_signs");
const orgId = fx.accountPage.organisation.id;

const client = new QueryClient();
const tree = (open = true) => (
	<I18nProvider i18n={i18n}>
		<MantineProvider env="test">
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<WhoSigns
						orgId={orgId}
						task={open ? (task ?? null) : null}
						onClose={vi.fn()}
					/>
				</MemoryRouter>
			</QueryClientProvider>
		</MantineProvider>
	</I18nProvider>
);

const show = async () => {
	const view = render(tree());
	await screen.findByTestId("signer-choose-offer");
	await waitFor(() =>
		expect(calls.some((c) => c.name === "accountPage")).toBe(true),
	);
	return view;
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

	it("says what is missing once Next is pressed, and each step starts untried", async () => {
		await show();
		const offerMissing = () =>
			screen.queryAllByText("Choose who signs the offer").length;
		const before = offerMissing();
		fireEvent.click(screen.getByTestId("who-signs-next"));
		expect(offerMissing()).toBe(before + 1);

		await pick("offer", /\(you\)/);
		fireEvent.click(screen.getByTestId("who-signs-next"));
		await screen.findByTestId("dpia-no");
		expect(screen.queryByText("Choose one.")).toBeNull();
		fireEvent.click(screen.getByTestId("who-signs-next"));
		expect(screen.getByText("Choose one.")).toBeTruthy();
	});

	it("starts over each time it opens", async () => {
		const view = await show();
		await pick("offer", /Sam Example/);
		fireEvent.click(screen.getByTestId("who-signs-next"));
		await screen.findByTestId("dpia-no");

		view.rerender(tree(false));
		view.rerender(tree(true));
		await screen.findByTestId("signer-choose-offer");
		expect(screen.queryByTestId("dpia-no")).toBeNull();
		expect(screen.queryByText(/Sam Example/)).toBeNull();
	});
});
