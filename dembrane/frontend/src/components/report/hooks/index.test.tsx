// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { freeAllowanceQueryKey } from "@/hooks/useFreeAllowance";
import { createProjectReport } from "@/lib/api";
import {
	useCancelScheduledReportMutation,
	useCreateProjectReportMutation,
	useDeleteProjectReportMutation,
	useUpdateProjectReportMutation,
} from "./index";

vi.mock("@/lib/api", () => ({
	cancelScheduledReport: vi.fn(async () => ({ cancelled: true })),
	createProjectReport: vi.fn(async () => ({ id: 1 })),
	deleteProjectReport: vi.fn(async () => ({ deleted: true })),
	updateProjectReport: vi.fn(async () => ({})),
}));
vi.mock("@/lib/bff", () => ({ bff: { get: vi.fn() } }));

const setup = () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	client.setQueryData(freeAllowanceQueryKey("ws-1"), { free: true });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const allowanceStale = () =>
		client.getQueryState(freeAllowanceQueryKey("ws-1"))?.isInvalidated;
	return { allowanceStale, wrapper };
};

const create = { language: "en", projectId: "p" };

it("a new report refetches the free allowance (it spends AI)", async () => {
	const { allowanceStale, wrapper } = setup();
	const { result } = renderHook(() => useCreateProjectReportMutation(), {
		wrapper,
	});
	await act(() => result.current.mutateAsync(create));
	expect(allowanceStale()).toBe(true);
});

it("a report refused for the AI budget refetches the free allowance", async () => {
	vi.mocked(createProjectReport).mockRejectedValueOnce({
		response: {
			data: {
				code: "billing.tier_limit",
				detail: { error: "FREE_TIER_LIMIT", limit: "ai_budget" },
				params: { limit: "ai_budget" },
			},
			status: 402,
		},
	});
	const { allowanceStale, wrapper } = setup();
	const { result } = renderHook(() => useCreateProjectReportMutation(), {
		wrapper,
	});
	await act(() => result.current.mutateAsync(create).catch(() => {}));
	expect(allowanceStale()).toBe(true);
});

it("cancelling, rescheduling or deleting a report gives no AI back, so the allowance stays", async () => {
	const { allowanceStale, wrapper } = setup();
	const cancel = renderHook(() => useCancelScheduledReportMutation(), {
		wrapper,
	});
	const update = renderHook(() => useUpdateProjectReportMutation(), {
		wrapper,
	});
	const remove = renderHook(() => useDeleteProjectReportMutation(), {
		wrapper,
	});
	await act(() =>
		cancel.result.current.mutateAsync({ projectId: "p", reportId: 1 }),
	);
	await act(() =>
		update.result.current.mutateAsync({
			payload: { status: "cancelled" },
			projectId: "p",
			reportId: 1,
		}),
	);
	await act(() =>
		remove.result.current.mutateAsync({ projectId: "p", reportId: 1 }),
	);
	expect(allowanceStale()).toBe(false);
});
