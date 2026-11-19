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
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { TaskT } from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";
import { NextSteps } from "./NextSteps";

// Replying to a task: the answer goes to dembrane, and a refusal shows in the
// modal until the next try or another task.
const call = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("../api/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/client")>()),
	call,
	submitTaskWithFile: vi.fn(),
}));
vi.mock("@/components/common/Toaster", () => ({
	toast: { success: toastSuccess },
}));
vi.mock("@/components/error/ErrorNotice", () => ({
	ErrorNotice: () => <div data-testid="error-notice" />,
}));
vi.mock("./WhoSigns", () => ({ WhoSigns: () => null }));
vi.mock("./SendToSomeoneElse", () => ({ SendToSomeoneElse: () => null }));

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
});
afterEach(() => {
	cleanup();
	call.mockReset();
	toastSuccess.mockReset();
});

const base = fx.accountPage.tasks[0] as TaskT;
const question = (id: string, title: string): TaskT => ({
	...base,
	body: null,
	code: null,
	document_id: null,
	due_on: null,
	id,
	kind: "generic",
	response_file_name: null,
	response_text: null,
	status: "open",
	title,
});
const first = question("t-1", "Send us your PO number");
const second = question("t-2", "Tell us your room size");

const show = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter>
						<NextSteps
							orgId="org"
							plan={{
								done: [],
								later: [],
								toDo: [first, second],
								toPay: [],
								waiting: [],
								withDpa: new Set(),
								withUs: [],
							}}
							documents={[]}
							today="2026-11-18"
							onBilling={() => {}}
							onBookCall={() => {}}
						/>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

const reply = (index: number, answer: string) => {
	fireEvent.click(screen.getAllByText("Reply")[index]);
	fireEvent.change(screen.getByLabelText("Your answer"), {
		target: { value: answer },
	});
	fireEvent.click(screen.getByText("Send"));
};

it("sends the answer to dembrane and closes", async () => {
	call.mockResolvedValue({});
	show();
	reply(0, "PO-1234");
	await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
	expect(call).toHaveBeenCalledWith("submitTask", {
		body: { response_text: "PO-1234" },
		params: { orgId: "org", taskId: "t-1" },
	});
	await waitFor(() =>
		expect(screen.queryByLabelText("Your answer")).toBeNull(),
	);
});

it("shows a refusal in the modal, and not on the next task", async () => {
	call.mockRejectedValue(new Error("nope"));
	show();
	reply(0, "PO-1234");
	expect(await screen.findByTestId("error-notice")).toBeTruthy();

	fireEvent.click(screen.getAllByText("Reply")[1]);
	await waitFor(() => expect(screen.queryByTestId("error-notice")).toBeNull());
});
