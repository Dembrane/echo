// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/errors/read";
import { useRefreshCanvasMutation } from "./index";

const { notifyError, post } = vi.hoisted(() => ({
	notifyError: vi.fn(),
	post: vi.fn(),
}));
vi.mock("@/lib/bff", () => ({ bff: { get: vi.fn(), post } }));
vi.mock("@/components/error/notifyError", () => ({ notifyError }));
vi.mock("@/components/common/Toaster", () => ({
	toast: { message: vi.fn(), success: vi.fn() },
}));

beforeEach(() => notifyError.mockClear());

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider
		client={
			new QueryClient({ defaultOptions: { mutations: { retry: false } } })
		}
	>
		{children}
	</QueryClientProvider>
);

it("leaves a used-up AI budget to the page's wall, not the error toast", async () => {
	post.mockRejectedValueOnce(
		new ApiRequestError(402, {
			code: "billing.tier_limit",
			detail: { error: "FREE_TIER_LIMIT", limit: "ai_budget" },
			params: { limit: "ai_budget" },
		}),
	);
	const { result } = renderHook(() => useRefreshCanvasMutation("c-1"), {
		wrapper,
	});
	await act(() => result.current.mutateAsync().catch(() => {}));
	expect(notifyError).not.toHaveBeenCalled();
});

it("still reports any other failure", async () => {
	post.mockRejectedValueOnce(new ApiRequestError(500, { code: "x" }));
	const { result } = renderHook(() => useRefreshCanvasMutation("c-1"), {
		wrapper,
	});
	await act(() => result.current.mutateAsync().catch(() => {}));
	expect(notifyError).toHaveBeenCalledTimes(1);
});
