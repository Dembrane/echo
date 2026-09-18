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
