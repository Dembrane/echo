// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeAll, expect, it, vi } from "vitest";
import { freeAllowanceQueryKey } from "@/hooks/useFreeAllowance";
import {
	useBulkMoveProjectsMutation,
	useCloneProjectByIdMutation,
	useMoveProjectMutation,
} from "./index";

vi.mock("@/components/common/Toaster", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api")>()),
	cloneProjectById: vi.fn(async () => "p2"),
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ count: 1, moved: ["p1"] }), {
					headers: { "Content-Type": "application/json" },
					status: 200,
				}),
		),
	);
});

const setup = <T,>(hook: () => T) => {
	const client = new QueryClient();
	client.setQueryData(freeAllowanceQueryKey("w1"), { free: true });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
	const { result } = renderHook(hook, { wrapper });
	const invalidated = () =>
		client.getQueryState(freeAllowanceQueryKey("w1"))?.isInvalidated;
	return { invalidated, result };
};

it("refreshes the free allowance after moving a project", async () => {
	const { result, invalidated } = setup(() => useMoveProjectMutation());
	await act(() =>
		result.current.mutateAsync({ projectId: "p1", targetWorkspaceId: "w2" }),
	);
	expect(invalidated()).toBe(true);
});

it("refreshes the free allowance after moving projects in bulk", async () => {
	const { result, invalidated } = setup(() => useBulkMoveProjectsMutation());
	await act(() =>
		result.current.mutateAsync({ projectIds: ["p1"], targetWorkspaceId: "w2" }),
	);
	expect(invalidated()).toBe(true);
});

it("refreshes the free allowance after cloning a project", async () => {
	const { result, invalidated } = setup(() => useCloneProjectByIdMutation());
	await act(() => result.current.mutateAsync({ id: "p1" }));
	expect(invalidated()).toBe(true);
});
