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
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/bff";
import type { TranslationStatus as Status } from "./hooks";
import { TranslationStatus } from "./TranslationStatus";

vi.mock("@/lib/bff", () => ({ bff: { post: vi.fn() } }));

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
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const status = (over: Partial<Status>): Status => ({
	detail: null,
	pending: 0,
	state: "done",
	target: "en",
	total: 12,
	translated: 12,
	...over,
});

function show(value?: Status | null, presentationId?: string) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<TranslationStatus presentationId={presentationId} status={value} />
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);
}

describe("How far the translation has got", () => {
	it("says nothing when no language was chosen, or before the server reports", () => {
		show(status({ state: "off" }));
		expect(screen.queryByTestId("present-translation-status")).toBeNull();
		cleanup();
		show(undefined);
		expect(screen.queryByTestId("present-translation-status")).toBeNull();
	});

	it("counts the texts when they are all there", () => {
		show(status({}));
		expect(
			screen.getByText("All 12 texts translated into English"),
		).toBeTruthy();
	});

	it("shows progress while it runs", () => {
		show(status({ pending: 3, state: "translating", translated: 9 }));
		expect(screen.getByText("Translating: 9 of 12 into English")).toBeTruthy();
		expect(screen.getByRole("progressbar")).toBeTruthy();
	});

	it("names what could not be translated", () => {
		show(
			status({
				detail: "Three phrases were refused",
				state: "incomplete",
				target: "nl",
				translated: 9,
			}),
		);
		expect(
			screen.getByText("9 of 12 translated, 3 could not be translated"),
		).toBeTruthy();
	});

	it("asks again for the left-over texts, and for nothing else", async () => {
		vi.mocked(bff.post).mockResolvedValue({});
		show(
			status({ pending: 3, state: "incomplete", translated: 9 }),
			"presentation-1",
		);
		fireEvent.click(screen.getByTestId("present-translation-retry-button"));
		await waitFor(() =>
			expect(bff.post).toHaveBeenCalledExactlyOnceWith(
				"/present/presentation-1/translate",
			),
		);
	});
});
