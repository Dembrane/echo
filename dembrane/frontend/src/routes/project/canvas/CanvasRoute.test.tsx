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
import { MemoryRouter, Route, Routes } from "react-router";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { CanvasRoute } from "./CanvasRoute";

const { state, navigate, invalidate, lifecycle, refresh, limits, frames } =
	vi.hoisted(() => ({
		frames: [] as (string | null)[],
		invalidate: vi.fn(),
		lifecycle: vi.fn(),
		limits: [] as number[],
		navigate: vi.fn(),
		refresh: vi.fn(),
		state: {
			canvas: {} as Record<string, unknown>,
			generations: [] as { id: string; created_at: string; status: string }[],
		},
	}));

vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/components/canvas/hooks", () => ({
	useCanvas: () => ({ data: state.canvas, isError: false, isLoading: false }),
	useCanvasGenerations: (_id: string, limit: number) => {
		limits.push(limit);
		return { data: state.generations, isFetching: false, isLoading: false };
	},
	useCanvasLifecycleMutation: () => ({ isPending: false, mutate: lifecycle }),
	useCanvasLoopSettingsMutation: () => ({ isPending: false, mutate: vi.fn() }),
	useInvalidateCanvasQueries: () => invalidate,
	useRefreshCanvasMutation: () => ({ isPending: false, mutate: refresh }),
}));
vi.mock("@/components/canvas/CanvasFrame", () => ({
	CanvasFrame: ({ generation }: { generation: { id: string } | null }) => {
		frames.push(generation?.id ?? null);
		return <div data-testid="frame">{generation?.id ?? "none"}</div>;
	},
}));
vi.mock("@/components/workspace/AiBudgetWall", () => ({
	AiBudgetWall: () => null,
	useAiBudgetWall: () => ({ openFor: vi.fn(), props: {} }),
}));

// One fake EventSource per connection, so a test can play the server.
class FakeEventSource {
	static all: FakeEventSource[] = [];
	listeners: Record<string, (() => void)[]> = {};
	onerror: (() => void) | null = null;
	closed = false;
	constructor(public url: string) {
		FakeEventSource.all.push(this);
	}
	addEventListener(type: string, fn: () => void) {
		this.listeners[type] = [...(this.listeners[type] ?? []), fn];
	}
	emit(type: string) {
		for (const fn of this.listeners[type] ?? []) fn();
	}
	close() {
		this.closed = true;
	}
}

i18n.loadAndActivate({ locale: "en-US", messages: {} });

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

const gen = (id: string, day: number) => ({
	created_at: new Date(2026, 10, day, 12).toISOString(),
	id,
	status: "success",
});

beforeEach(() => {
	vi.clearAllMocks();
	frames.length = 0;
	limits.length = 0;
	FakeEventSource.all = [];
	vi.stubGlobal("EventSource", FakeEventSource);
	state.generations = [gen("g1", 1), gen("g3", 3), gen("g2", 2)];
	state.canvas = {
		created_from_chat_id: "chat-9",
		id: "cv1",
		latest_generation: gen("g3", 3),
		loop: { expires_at: null, status: "active" },
		name: "Themes",
		project_id: "p1",
	};
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const showTree = () => (
	<I18nProvider i18n={i18n}>
		<MantineProvider>
			<MemoryRouter initialEntries={["/w/w1/canvases/cv1"]}>
				<Routes>
					<Route
						path="/w/:workspaceId/canvases/:canvasId"
						element={<CanvasRoute />}
					/>
				</Routes>
			</MemoryRouter>
		</MantineProvider>
	</I18nProvider>
);
const show = () => render(showTree());

const frame = () => screen.getByTestId("frame").textContent;

describe("CanvasRoute", () => {
	it("shows the live version, an older one when picked, and live again after", () => {
		show();
		expect(frame()).toBe("g3");
		fireEvent.click(screen.getByTestId("canvas-version-g1"));
		expect(frame()).toBe("g1");
		fireEvent.click(screen.getByRole("button", { name: "Back to live" }));
		expect(frame()).toBe("g3");
	});

	it("lists versions newest first", () => {
		show();
		const ids = screen
			.getAllByTestId(/^canvas-version-g/)
			.map((el) => el.getAttribute("data-testid"));
		expect(ids).toEqual([
			"canvas-version-g3",
			"canvas-version-g2",
			"canvas-version-g1",
		]);
	});

	it("opens the chat it came from, or starts one about it", () => {
		show();
		fireEvent.click(screen.getByTestId("canvas-open-chat-button"));
		expect(navigate).toHaveBeenLastCalledWith("/w/w1/projects/p1/chats/chat-9");
		cleanup();

		state.canvas = { ...state.canvas, created_from_chat_id: null };
		show();
		fireEvent.click(screen.getByTestId("canvas-new-chat-button"));
		expect(navigate).toHaveBeenLastCalledWith(
			`/w/w1/projects/p1/chats/new?prefill=${encodeURIComponent(
				'Let\'s talk about the canvas "Themes".',
			)}`,
		);
	});

	it("pauses an active loop from the menu", async () => {
		show();
		fireEvent.click(screen.getByTestId("canvas-actions-menu-button"));
		fireEvent.click(await screen.findByTestId("canvas-lifecycle-button"));
		expect(lifecycle).toHaveBeenCalledWith("pause");
	});

	it("fills the freshness settings from the loop, keeps an edit, and follows a new loop", async () => {
		Element.prototype.scrollIntoView ??= () => {};
		const loop = {
			cadence_minutes: 15,
			expires_at: "2026-12-01T10:00:00.000Z",
			status: "active",
		};
		state.canvas = { ...state.canvas, loop };
		const view = show();
		fireEvent.click(screen.getByTestId("canvas-freshness-settings-button"));
		const rhythm = () =>
			screen.getByRole("textbox", {
				name: "Update rhythm",
			}) as HTMLInputElement;
		expect(
			await screen.findByRole("textbox", { name: "Update rhythm" }),
		).toBeTruthy();
		expect(rhythm().value).toBe("Every 15 minutes");

		fireEvent.click(rhythm());
		fireEvent.click(
			await screen.findByRole("option", { name: "Every 5 minutes" }),
		);
		expect(rhythm().value).toBe("Every 5 minutes");
		// A reread of the same loop keeps the host's edit.
		state.canvas = { ...state.canvas, loop: { ...loop } };
		view.rerender(showTree());
		expect(rhythm().value).toBe("Every 5 minutes");

		state.canvas = { ...state.canvas, loop: { ...loop, cadence_minutes: 60 } };
		view.rerender(showTree());
		expect(rhythm().value).toBe("Every 60 minutes");
	});

	it("asks for more versions when Show more is pressed", () => {
		state.generations = Array.from({ length: 10 }, (_, i) =>
			gen(`g${i}`, i + 1),
		);
		show();
		expect(limits.at(-1)).toBe(10);
		fireEvent.click(screen.getByTestId("canvas-versions-show-more"));
		expect(limits.at(-1)).toBe(35);
	});

	it("rereads on a new generation, and after a reconnect, but not on the first connect", () => {
		vi.useFakeTimers();
		show();
		const first = FakeEventSource.all[0];
		act(() => first.emit("connected"));
		expect(invalidate).not.toHaveBeenCalled();
		act(() => first.emit("generation"));
		expect(invalidate).toHaveBeenCalledTimes(1);

		act(() => first.onerror?.());
		expect(first.closed).toBe(true);
		act(() => vi.advanceTimersByTime(1000));
		const second = FakeEventSource.all[1];
		act(() => second.emit("connected"));
		expect(invalidate).toHaveBeenCalledTimes(2);

		cleanup();
		expect(second.closed).toBe(true);
		vi.useRealTimers();
	});
});
