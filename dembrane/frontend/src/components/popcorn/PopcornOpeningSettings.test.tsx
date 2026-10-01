// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { PopcornDetail } from "@/components/popcorn/hooks";
import { SettingsSaveContext } from "@/components/popcorn/SettingsSaveContext";
import { PopcornOpeningSettings } from "./PopcornOpeningSettings";

const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock("@/components/popcorn/hooks", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/components/popcorn/hooks")>();
	return {
		...actual,
		usePopcornSettingsMutation: () => ({ isPending: false, mutateAsync }),
	};
});

i18n.load("en", {});
i18n.activate("en");

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query) => ({
		addEventListener() {},
		matches: false,
		media: query,
		removeEventListener() {},
	}));
	globalThis.ResizeObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
	};
});

beforeEach(() => {
	vi.useFakeTimers();
	mutateAsync.mockReset();
	mutateAsync.mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const popcorn = (overrides: Partial<PopcornDetail> = {}): PopcornDetail =>
	({
		counts: {
			conversations: 0,
			conversations_read: 0,
			held_back: 0,
			phrases: 0,
			quotes: 0,
			stakeholders: 0,
			tensions: 0,
			validated: 0,
		},
		id: "pop-1",
		kind: "popcorn",
		name: "Workshop",
		settings: {
			client: "",
			data: { enabled: true },
			disclosure: {
				enabled: true,
				invitation_text: "Join us",
				invitation_title: "Next",
				text: "Recorded for this workshop",
			},
			intro: { enabled: true, subtitle: "Old subtitle", title: "Old title" },
			notice: { enabled: true, text: "Workshop frame" },
			public: false,
			public_labels: "neutral",
			show_branding: true,
			show_qr: true,
			tabs: { stakeholders: false, tensions: false },
			title: "Workshop",
			voice: { note: "", presets: [] },
		},
		...overrides,
	}) as PopcornDetail;

const view = (detail: PopcornDetail, section?: "intro" | "data") =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<PopcornOpeningSettings
					popcorn={detail}
					projectId="project-1"
					section={section}
				/>
			</MantineProvider>
		</I18nProvider>,
	);

const finishDebounce = async () => {
	await act(async () => {
		vi.advanceTimersByTime(1_000);
		await Promise.resolve();
	});
};

describe("PopcornOpeningSettings autosave", () => {
	it("autosaves the intro section without a per-card Save button or nested card", async () => {
		view(popcorn(), "intro");
		expect(screen.queryByRole("button", { name: /Save opening/i })).toBeNull();
		expect(
			screen.queryByRole("heading", { name: "Opening and frame" }),
		).toBeNull();
		expect(screen.getByTestId("popcorn-opening").className).not.toContain(
			"mantine-Paper-root",
		);

		fireEvent.change(screen.getByLabelText("Introduction title"), {
			target: { value: "A new opening" },
		});
		expect(screen.getByText(/saved automatically/i)).toBeTruthy();
		expect(mutateAsync).not.toHaveBeenCalled();
		await finishDebounce();

		expect(mutateAsync).toHaveBeenCalledWith({
			intro: {
				enabled: true,
				subtitle: "Old subtitle",
				title: "A new opening",
			},
			notice: { enabled: true, text: "Workshop frame" },
		});
	});

	it("keeps newer typing when an older server snapshot refetches", () => {
		const first = popcorn();
		const rendered = view(first, "intro");
		const title = screen.getByLabelText(
			"Introduction title",
		) as HTMLInputElement;
		fireEvent.change(title, { target: { value: "Still typing" } });

		const refetched = popcorn({
			settings: {
				...first.settings,
				intro: { ...first.settings.intro, title: "Older saved value" },
			},
		});
		rendered.rerender(
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<PopcornOpeningSettings
						popcorn={refetched}
						projectId="project-1"
						section="intro"
					/>
				</MantineProvider>
			</I18nProvider>,
		);

		expect(
			(screen.getByLabelText("Introduction title") as HTMLInputElement).value,
		).toBe("Still typing");
	});

	it("saves only data-section fields and keeps synthetic fields locked", async () => {
		const detail = popcorn({ synthetic: true });
		view(detail, "data");
		expect(screen.queryByLabelText("Show a disclosure")).toBeNull();
		expect(screen.getByTestId("popcorn-synthetic-note")).toBeTruthy();

		fireEvent.click(screen.getByTestId("popcorn-data-toggle"));
		await finishDebounce();
		expect(mutateAsync).toHaveBeenCalledWith({ data: { enabled: false } });
	});

	it("flushes a pending debounce through the shared Present save context", async () => {
		let flush: (() => Promise<void>) | undefined;
		const registerFlush = vi.fn((next: () => Promise<void>) => {
			flush = next;
			return () => {
				flush = undefined;
			};
		});
		render(
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<SettingsSaveContext.Provider
						value={{ registerFlush, save: vi.fn(), setFieldPending: vi.fn() }}
					>
						<PopcornOpeningSettings
							popcorn={popcorn()}
							projectId="project-1"
							section="intro"
						/>
					</SettingsSaveContext.Provider>
				</MantineProvider>
			</I18nProvider>,
		);
		fireEvent.change(screen.getByLabelText("Introduction title"), {
			target: { value: "Publish this" },
		});
		expect(flush).toBeTypeOf("function");

		await act(async () => {
			await flush?.();
		});
		expect(mutateAsync).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(1_000);
		expect(mutateAsync).toHaveBeenCalledOnce();
	});
});
