// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, expect, it, vi } from "vitest";
import { freeAllowanceQueryKey } from "./useFreeAllowance";
import { useCreateWorkspaceProject } from "./useWorkspaceProjects";

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspaceId: "w1" }),
}));

beforeAll(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({ id: "p1", name: "A", workspace_id: "w1" }),
					{
						headers: { "Content-Type": "application/json" },
						status: 200,
					},
				),
		),
	);
});

it("refreshes the free allowance after creating a project, so the project cap shows", async () => {
	const client = new QueryClient();
	client.setQueryData(freeAllowanceQueryKey("w1"), { free: true });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(() => useCreateWorkspaceProject(), { wrapper });
	await act(() => result.current.mutateAsync({ language: "en", name: "A" }));
	expect(client.getQueryState(freeAllowanceQueryKey("w1"))?.isInvalidated).toBe(
		true,
	);
});
