// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectTagsInput } from "./ProjectTagsInput";

const drag = vi.hoisted(() => ({
	end: undefined as undefined | ((e: unknown) => void),
}));
const notify = vi.hoisted(() => vi.fn());

// jsdom cannot drive a real pointer drag, so the test fires the drop itself.
vi.mock("@dnd-kit/core", () => ({
	closestCenter: vi.fn(),
	DndContext: ({
		children,
		onDragEnd,
	}: {
		children: React.ReactNode;
		onDragEnd: (e: unknown) => void;
	}) => {
		drag.end = onDragEnd;
		return <div>{children}</div>;
	},
	KeyboardSensor: class {},
	PointerSensor: class {},
	useSensor: vi.fn(),
	useSensors: vi.fn(),
}));
vi.mock("@dnd-kit/sortable", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dnd-kit/sortable")>()),
	horizontalListSortingStrategy: vi.fn(),
	SortableContext: ({ children }: { children: React.ReactNode }) => children,
	useSortable: () => ({
		attributes: {},
		isDragging: false,
		listeners: {},
		setNodeRef: vi.fn(),
		transform: null,
		transition: undefined,
	}),
}));
vi.mock("@/components/error/notifyError", () => ({ notifyError: notify }));
vi.mock("@/components/common/Toaster", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia ??= ((query: string) => ({
		addEventListener: vi.fn(),
		addListener: vi.fn(),
		dispatchEvent: vi.fn(),
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: vi.fn(),
		removeListener: vi.fn(),
	})) as unknown as typeof window.matchMedia;
	window.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

type Patch = {
	id: string;
	sort: number;
	resolve: () => void;
	reject: () => void;
};

// A server that holds tag saves until the test settles them, like a slow network.
const stubServer = () => {
	const saved: Record<string, number> = { a: 1, b: 2, c: 3 };
	const patches: Patch[] = [];
	let gets = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (init?.method === "PATCH") {
				const id = String(url).split("/").pop() as string;
				const { sort } = JSON.parse(String(init.body));
				return new Promise<Response>((resolve) => {
					patches.push({
						id,
						reject: () => resolve(new Response("{}", { status: 500 })),
						resolve: () => {
							saved[id] = sort;
							resolve(new Response(JSON.stringify({ id, sort })));
						},
						sort,
					});
				});
			}
			gets += 1;
			return new Response(
				JSON.stringify({
					id: "p1",
					tags: ["a", "b", "c"].map((id) => ({
						id,
						sort: saved[id],
						text: `tag-${id}`,
					})),
				}),
			);
		}),
	);
	return { gets: () => gets, patches };
};

const renderTags = () => {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<ProjectTagsInput project={{ id: "p1" } as Project} />
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);
};

const order = () =>
	screen.getAllByText(/^tag-/).map((el) => el.textContent as string);

const drop = (active: string, over: string) =>
	act(() => drag.end?.({ active: { id: active }, over: { id: over } }));

describe("ProjectTagsInput reordering", () => {
	it("keeps the dropped order while saves are pending, saves only moved tags, refetches once", async () => {
		const server = stubServer();
		renderTags();
		await screen.findByText("tag-a");
		expect(order()).toEqual(["tag-a", "tag-b", "tag-c"]);
		const getsBefore = server.gets();

		drop("a", "c");
		expect(order()).toEqual(["tag-b", "tag-c", "tag-a"]);
		await waitFor(() => expect(server.patches).toHaveLength(3));

		// The first save lands: the screen must not fall back to the old order.
		await act(async () => server.patches[0].resolve());
		expect(server.gets()).toBe(getsBefore);
		expect(order()).toEqual(["tag-b", "tag-c", "tag-a"]);

		await act(async () => {
			server.patches[1].resolve();
			server.patches[2].resolve();
		});
		await waitFor(() => expect(server.gets()).toBe(getsBefore + 1));
		await waitFor(() => expect(order()).toEqual(["tag-b", "tag-c", "tag-a"]));
		expect(notify).not.toHaveBeenCalled();
	});

	it("saves only the tags whose place changed", async () => {
		const server = stubServer();
		renderTags();
		await screen.findByText("tag-a");

		drop("b", "a");
		expect(order()).toEqual(["tag-b", "tag-a", "tag-c"]);
		await waitFor(() => expect(server.patches).toHaveLength(2));
		expect(server.patches.map((p) => p.id).sort()).toEqual(["a", "b"]);
	});

	it("goes back to the saved order and says so when a save fails", async () => {
		notify.mockClear();
		const server = stubServer();
		renderTags();
		await screen.findByText("tag-a");

		drop("a", "c");
		await waitFor(() => expect(server.patches).toHaveLength(3));
		expect(order()).toEqual(["tag-b", "tag-c", "tag-a"]);

		await act(async () => {
			for (const patch of server.patches) patch.reject();
		});
		await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(order()).toEqual(["tag-a", "tag-b", "tag-c"]));
	});
});
