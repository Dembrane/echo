// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({ default: { captureException } }));
vi.mock("@/components/auth/hooks", () => ({
	useCurrentUser: () => ({ data: { id: "u1" } }),
}));
vi.mock("@/components/common/Toaster", () => ({
	toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock("@/config", () => ({ API_BASE_URL: "/api" }));

const { useUnreadAnnouncements } = await import("./index");
const { queryRetry } = await import("@/lib/queryRetry");

const fetchMock = vi.fn();

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider
		client={
			new QueryClient({ defaultOptions: { queries: { retry: queryRetry } } })
		}
	>
		{children}
	</QueryClientProvider>
);

const answer = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	fetchMock.mockReset();
	captureException.mockReset();
});

it("an ended session stops the unread poll and is not reported", async () => {
	fetchMock.mockResolvedValue(
		answer(401, { action: "sign_in", code: "auth.session_expired" }),
	);
	const { result } = renderHook(() => useUnreadAnnouncements(), { wrapper });

	await vi.advanceTimersByTimeAsync(10 * 60_000);

	expect(result.current.isError).toBe(true);
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(captureException).not.toHaveBeenCalled();
});

it("a server failure is still retried and reported", async () => {
	fetchMock.mockResolvedValue(answer(500, {}));
	const { result } = renderHook(() => useUnreadAnnouncements(), { wrapper });

	await vi.advanceTimersByTimeAsync(30_000);
	await waitFor(() => expect(result.current.isError).toBe(true));

	expect(fetchMock).toHaveBeenCalledTimes(4);
	expect(captureException).toHaveBeenCalled();
});

it("a 404 stops the poll but is still reported", async () => {
	fetchMock.mockResolvedValue(answer(404, { code: "request.route_not_found" }));
	const { result } = renderHook(() => useUnreadAnnouncements(), { wrapper });

	await vi.advanceTimersByTimeAsync(5 * 60_000);

	expect(result.current.isError).toBe(true);
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(captureException).toHaveBeenCalledTimes(1);
});
