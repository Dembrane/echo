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

type Save = {
	order: string[];
	resolve: () => void;
	reject: () => void;
};

// A server that holds tag order saves until the test settles them, like a slow
// network. A save sets every tag or, when it fails, none.
const stubServer = () => {
	const saved: Record<string, number> = { a: 1, b: 2, c: 3 };
	const saves: Save[] = [];
	let gets = 0;
	let gate: Promise<void> | null = null;
	let release = () => {};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (init?.method === "POST" && String(url).endsWith("/tags/reorder")) {
				const { tag_ids } = JSON.parse(String(init.body));
				return new Promise<Response>((resolve) => {
					saves.push({
						order: tag_ids,
						reject: () => resolve(new Response("{}", { status: 500 })),
						resolve: () => {
							tag_ids.forEach((id: string, i: number) => {
								saved[id] = i + 1;
							});
							resolve(new Response("[]"));
						},
					});
				});
			}
			gets += 1;
			const body = JSON.stringify({
				id: "p1",
				tags: ["a", "b", "c"].map((id) => ({
					id,
					sort: saved[id],
					text: `tag-${id}`,
				})),
			});
			await gate;
			return new Response(body);
		}),
	);
	return {
		gets: () => gets,
		// Holds the next refetches until release() is called.
		hold: () => {
			gate = new Promise<void>((resolve) => {
				release = () => {
					gate = null;
					resolve();
				};
			});
		},
		release: () => release(),
		saved,
		saves,
	};
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
	it("keeps the dropped order while the save is pending, saves it in one request, refetches once", async () => {
		notify.mockClear();
		const server = stubServer();
		renderTags();
		await screen.findByText("tag-a");
		expect(order()).toEqual(["tag-a", "tag-b", "tag-c"]);
		const getsBefore = server.gets();

		drop("a", "c");
		expect(order()).toEqual(["tag-b", "tag-c", "tag-a"]);
		await waitFor(() => expect(server.saves).toHaveLength(1));
		expect(server.saves[0].order).toEqual(["b", "c", "a"]);
		expect(server.gets()).toBe(getsBefore);

		await act(async () => server.saves[0].resolve());
		await waitFor(() => expect(server.gets()).toBe(getsBefore + 1));
		await waitFor(() => expect(order()).toEqual(["tag-b", "tag-c", "tag-a"]));
		expect(server.saved).toEqual({ a: 3, b: 1, c: 2 });
		expect(notify).not.toHaveBeenCalled();
	});

	it("goes back to the order from before the drop and says so when the save fails", async () => {
		notify.mockClear();
		const server = stubServer();
		renderTags();
		await screen.findByText("tag-a");

		drop("a", "c");
		await waitFor(() => expect(server.saves).toHaveLength(1));
		expect(order()).toEqual(["tag-b", "tag-c", "tag-a"]);

		await act(async () => server.saves[0].reject());
		await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(order()).toEqual(["tag-a", "tag-b", "tag-c"]));
		expect(server.saved).toEqual({ a: 1, b: 2, c: 3 });
	});

	it("keeps a second drag on screen when it lands before the first refetch is done", async () => {
		notify.mockClear();
		const server = stubServer();
		renderTags();
		await screen.findByText("tag-a");
		const getsBefore = server.gets();

		drop("a", "c");
		await waitFor(() => expect(server.saves).toHaveLength(1));
		server.hold();
		await act(async () => server.saves[0].resolve());
		await waitFor(() => expect(server.gets()).toBe(getsBefore + 1));

		// The first refetch is still out; its data does not know the second drop.
		drop("c", "b");
		expect(order()).toEqual(["tag-c", "tag-b", "tag-a"]);
		await act(async () => server.release());
		expect(order()).toEqual(["tag-c", "tag-b", "tag-a"]);

		await waitFor(() => expect(server.saves).toHaveLength(2));
		await act(async () => server.saves[1].resolve());

		await waitFor(() => expect(server.gets()).toBe(getsBefore + 2));
		await waitFor(() => expect(order()).toEqual(["tag-c", "tag-b", "tag-a"]));
		expect(server.saved).toEqual({ a: 3, b: 2, c: 1 });
		expect(notify).not.toHaveBeenCalled();
	});

	it("sends a quick second drag only after the first save, and its success clears the first one's failure", async () => {
		notify.mockClear();
		const server = stubServer();
		renderTags();
		await screen.findByText("tag-a");

		drop("a", "c");
		drop("c", "b");
		expect(order()).toEqual(["tag-c", "tag-b", "tag-a"]);
		await waitFor(() => expect(server.saves).toHaveLength(1));

		await act(async () => server.saves[0].reject());
		await waitFor(() => expect(server.saves).toHaveLength(2));
		expect(server.saves[1].order).toEqual(["c", "b", "a"]);
		expect(order()).toEqual(["tag-c", "tag-b", "tag-a"]);

		await act(async () => server.saves[1].resolve());
		await waitFor(() => expect(server.saved).toEqual({ a: 3, b: 2, c: 1 }));
		await waitFor(() => expect(order()).toEqual(["tag-c", "tag-b", "tag-a"]));
		expect(notify).not.toHaveBeenCalled();
	});
});
