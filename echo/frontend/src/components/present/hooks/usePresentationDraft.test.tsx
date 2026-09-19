// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { bff } from "@/lib/bff";
import { usePresentationDraft } from "./usePresentationDraft";

vi.mock("@/lib/bff", () => ({
	bff: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
}));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("serializes edits with the latest revision and keeps the live cache unchanged until publish", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const liveKey = ["project", "project-1", "presentation"];
	const live = { presentation: { id: "p", settings: { title: "Published" } } };
	client.setQueryData(liveKey, live);
	const envelope = (revision: number, title: string, has_changes = true) => ({
		has_changes,
		presentation: { id: "p", settings: { title } },
		revision,
	});
	vi.mocked(bff.get).mockResolvedValue(envelope(2, "Published", false));
	let release: (value: unknown) => void = () => {};
	vi.mocked(bff.patch)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}) as never,
		)
		.mockResolvedValueOnce(envelope(4, "Second edit"));
	vi.mocked(bff.post).mockResolvedValue(envelope(5, "Second edit", false));
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(
		() => usePresentationDraft("project-1", "p", true),
		{ wrapper },
	);
	await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
	let first!: Promise<unknown>;
	let second!: Promise<unknown>;
	act(() => {
		first = result.current.save.mutateAsync({ title: "First edit" });
		second = result.current.save.mutateAsync({ title: "Second edit" });
	});
	await waitFor(() => expect(bff.patch).toHaveBeenCalledTimes(1));
	await act(async () => {
		release(envelope(3, "First edit"));
		await Promise.all([first, second]);
	});
	expect(vi.mocked(bff.patch).mock.calls.map((call) => call[1])).toEqual([
		{ expected_revision: 2, patch: { title: "First edit" } },
		{ expected_revision: 3, patch: { title: "Second edit" } },
	]);
	expect(client.getQueryData(liveKey)).toEqual(live);
	expect(client.getQueryState(liveKey)?.isInvalidated).toBe(false);
	await act(async () => {
		await result.current.publish.mutateAsync();
	});
	expect(bff.post).toHaveBeenCalledWith("/present/p/publish", {
		expected_revision: 4,
	});
	expect(client.getQueryState(liveKey)?.isInvalidated).toBe(true);
	client.clear();
});

it("resends an edit once against the draft another host moved on, and leaves a conflicting publish to the host", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const envelope = (revision: number, title: string) => ({
		has_changes: true,
		presentation: { id: "p", settings: { title } },
		revision,
	});
	const conflict = Object.assign(new Error("changed elsewhere"), {
		status: 409,
	});
	vi.mocked(bff.get)
		.mockResolvedValueOnce(envelope(2, "Published"))
		.mockResolvedValue(envelope(6, "Their edit"));
	vi.mocked(bff.patch)
		.mockRejectedValueOnce(conflict)
		.mockResolvedValueOnce(envelope(7, "My edit"));
	vi.mocked(bff.post).mockRejectedValueOnce(conflict);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(
		() => usePresentationDraft("project-1", "p", true),
		{ wrapper },
	);
	await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

	await act(async () => {
		await result.current.save.mutateAsync({ title: "My edit" });
	});
	expect(vi.mocked(bff.patch).mock.calls.map((call) => call[1])).toEqual([
		{ expected_revision: 2, patch: { title: "My edit" } },
		{ expected_revision: 6, patch: { title: "My edit" } },
	]);

	await act(async () => {
		await result.current.publish.mutateAsync().catch(() => {});
	});
	expect(bff.post).toHaveBeenCalledOnce();
	await waitFor(() =>
		expect(
			client.getQueryState(["presentation-draft", "p"])?.isInvalidated,
		).toBe(false),
	);
	expect(vi.mocked(bff.get).mock.calls.length).toBeGreaterThanOrEqual(3);
	client.clear();
});

const draftEnvelope = (
	revision: number,
	settings: Record<string, unknown>,
) => ({
	has_changes: revision > 2,
	presentation: { id: "p", settings },
	revision,
});

const mount = (client: QueryClient) => {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return renderHook(() => usePresentationDraft("project-1", "p", true), {
		wrapper,
	});
};

const cachedSettings = (client: QueryClient) =>
	(
		client.getQueryData(["presentation-draft", "p"]) as
			| { presentation: { settings: Record<string, unknown> } }
			| undefined
	)?.presentation.settings;

it("shows a toggle in the cache before the server answers, merging the way the server does", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const settings = {
		language: { translate_to: "", ui: "auto" },
		presentation: {
			blocks: ["popcorn"],
			result_bindings: { map: "snapshot-1" },
		},
		title: "Workshop",
	};
	vi.mocked(bff.get).mockResolvedValue(draftEnvelope(2, settings));
	vi.mocked(bff.patch).mockImplementation(() => new Promise(() => {}) as never);
	const { result } = mount(client);
	await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

	act(() => {
		void result.current.save.mutate({
			language: { translate_to: "nl" },
			presentation: {
				blocks: ["popcorn", "tensions"],
				result_bindings: { tensions: "snapshot-2" },
			},
			title: "Room screen",
		});
	});

	await waitFor(() =>
		expect(cachedSettings(client)).toEqual({
			// A scalar replaces, a named block shallow-merges, and the bindings
			// merge per key so the map's binding survives the tensions patch.
			language: { translate_to: "nl", ui: "auto" },
			presentation: {
				blocks: ["popcorn", "tensions"],
				result_bindings: { map: "snapshot-1", tensions: "snapshot-2" },
			},
			title: "Room screen",
		}),
	);
	expect(bff.patch).toHaveBeenCalledOnce();
	client.clear();
});

it("puts the draft back when a lone save fails", async () => {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	const settings = { presentation: { blocks: ["popcorn"] }, title: "Workshop" };
	vi.mocked(bff.get).mockResolvedValue(draftEnvelope(2, settings));
	vi.mocked(bff.patch).mockRejectedValue(new Error("offline"));
	const { result } = mount(client);
	await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

	await act(async () => {
		await result.current.save
			.mutateAsync({ presentation: { blocks: ["popcorn", "map"] } })
			.catch(() => {});
	});
	expect(cachedSettings(client)).toEqual(settings);
	client.clear();
});

it("does not erase a queued patch when the save before it fails", async () => {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	const settings = { presentation: { blocks: ["popcorn"] }, title: "Workshop" };
	// The refetch after the failure answers with the draft as the server has it:
	// the first patch never landed, the second one did.
	const after = { presentation: { blocks: ["popcorn", "tensions"] } };
	vi.mocked(bff.get)
		.mockResolvedValueOnce(draftEnvelope(2, settings))
		.mockResolvedValue(draftEnvelope(3, after));
	let failFirst: (error: unknown) => void = () => {};
	vi.mocked(bff.patch)
		.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					failFirst = reject;
				}) as never,
		)
		.mockResolvedValueOnce(draftEnvelope(3, after));
	const { result } = mount(client);
	await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

	let first!: Promise<unknown>;
	let second!: Promise<unknown>;
	act(() => {
		first = result.current.save
			.mutateAsync({ presentation: { blocks: ["popcorn", "map"] } })
			.catch(() => {});
		second = result.current.save.mutateAsync({
			presentation: { blocks: ["popcorn", "tensions"] },
		});
	});
	await waitFor(() =>
		expect(
			(cachedSettings(client)?.presentation as { blocks: string[] }).blocks,
		).toEqual(["popcorn", "tensions"]),
	);
	await act(async () => {
		failFirst(new Error("offline"));
		await Promise.all([first, second]);
	});

	// The rollback of the first save must not put the second patch's block back.
	expect(
		(cachedSettings(client)?.presentation as { blocks: string[] }).blocks,
	).toEqual(["popcorn", "tensions"]);
	client.clear();
});
