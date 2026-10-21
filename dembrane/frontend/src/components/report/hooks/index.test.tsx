// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { freeAllowanceQueryKey } from "@/hooks/useFreeAllowance";
import {
	useCancelScheduledReportMutation,
	useUpdateProjectReportMutation,
} from "./index";

vi.mock("@/lib/api", () => ({
	cancelScheduledReport: vi.fn(async () => ({ cancelled: true })),
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

it("cancel schedule refetches the free allowance", async () => {
	const { allowanceStale, wrapper } = setup();
	const { result } = renderHook(() => useCancelScheduledReportMutation(), {
		wrapper,
	});
	expect(allowanceStale()).toBe(false);
	await act(() => result.current.mutateAsync({ projectId: "p", reportId: 1 }));
	expect(allowanceStale()).toBe(true);
});

it("a report update (cancel or reschedule) refetches the free allowance", async () => {
	const { allowanceStale, wrapper } = setup();
	const { result } = renderHook(() => useUpdateProjectReportMutation(), {
		wrapper,
	});
	await act(() =>
		result.current.mutateAsync({
			payload: { status: "cancelled" },
			projectId: "p",
			reportId: 1,
		}),
	);
	expect(allowanceStale()).toBe(true);
});
