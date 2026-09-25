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
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { bff } from "@/lib/bff";
import { EvidenceInspectionDrawer } from "./EvidenceInspectionDrawer";

vi.mock("@/lib/bff", () => ({ bff: { get: vi.fn(), post: vi.fn() } }));

const item = {
	label: "A phrase",
	objectId: "obj-1",
	payload: { phrase: "as prepared", question: false },
	revisionId: "rev-1",
	type: "popcorn",
};
const firstRevision = {
	membershipExcluded: false,
	objectId: "obj-1",
	payload: { phrase: "as prepared" },
	revisionId: "rev-1",
	revisionNumber: 1,
	status: "published",
	type: "popcorn",
};
const newerRevision = {
	...firstRevision,
	payload: { phrase: "someone else's wording" },
	revisionId: "rev-2",
	revisionNumber: 2,
};

let settleRefetch: () => void;

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia = vi.fn().mockImplementation((media) => ({
		addEventListener() {},
		matches: false,
		media,
		removeEventListener() {},
	}));
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});
beforeEach(() => {
	let historyReads = 0;
	vi.mocked(bff.get).mockImplementation(async (url: string) => {
		if (!url.endsWith("/revisions")) return {};
		historyReads += 1;
		if (historyReads === 1)
			return { object: {}, revisions: [firstRevision] } as unknown;
		// Hold the refetch open so the conflict alert can be inspected mid-flight.
		return new Promise((resolve) => {
			settleRefetch = () =>
				resolve({ object: {}, revisions: [firstRevision, newerRevision] });
		});
	});
	vi.mocked(bff.post).mockRejectedValue(
		Object.assign(new Error("conflict"), { status: 409 }),
	);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function show(shown: typeof item & { membershipExcluded?: boolean } = item) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter>
						<EvidenceInspectionDrawer
							projectId="project-1"
							snapshotId={null}
							item={shown}
							editable
							opened
							onClose={() => {}}
						/>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
}

describe("a result that changed while the host was editing it", () => {
	it("holds the typed wording and waits for fresh history before offering it", async () => {
		show();
		const phrase = (await screen.findByLabelText("Phrase")) as HTMLInputElement;
		fireEvent.change(phrase, { target: { value: "the host's wording" } });
		fireEvent.click(screen.getByRole("button", { name: "Publish revision" }));

		expect(
			await screen.findByText(
				"This result changed while you were reviewing it.",
			),
		).toBeTruthy();
		const load = screen.getByRole("button", { name: "Load latest revision" });
		expect(load.hasAttribute("disabled")).toBe(true);
		expect(phrase.value).toBe("the host's wording");

		settleRefetch();
		await waitFor(() => expect(load.hasAttribute("disabled")).toBe(false));
		fireEvent.click(load);
		await waitFor(() => expect(phrase.value).toBe("someone else's wording"));
	});
});

const argument = {
	label: "Buses are cheaper.",
	objectId: "obj-9",
	payload: { statement: "Buses are cheaper." },
	revisionId: "rev-9",
	type: "argument",
};
const DOWNSTREAM = /Tensions and merged arguments/;

describe("withdrawing a result", () => {
	it("tells the host an argument also leaves tensions and merged arguments", async () => {
		show(argument as unknown as typeof item);
		fireEvent.click(
			await screen.findByRole("button", { name: "Withdraw result" }),
		);

		expect(await screen.findByText(DOWNSTREAM)).toBeTruthy();
	});

	it("says nothing about tensions for a result nothing else reads", async () => {
		show();
		fireEvent.click(
			await screen.findByRole("button", { name: "Withdraw result" }),
		);

		expect(
			await screen.findByText(/Withdraw this result from current Map/),
		).toBeTruthy();
		expect(screen.queryByText(DOWNSTREAM)).toBeNull();
	});

	it("keeps the downstream note beside a withdrawn argument", async () => {
		show({ ...argument, membershipExcluded: true } as unknown as typeof item);

		expect(
			await screen.findByRole("button", { name: "Restore result" }),
		).toBeTruthy();
		expect(screen.getByText(DOWNSTREAM)).toBeTruthy();
	});
});
