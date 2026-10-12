// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import posthog from "posthog-js";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCurrentUser } from "@/components/auth/hooks";
import { useInfiniteAnnouncements, useWhatsNewAnnouncements } from "./index";

vi.mock("@/components/auth/hooks", () => ({ useCurrentUser: vi.fn() }));
vi.mock("@/components/common/Toaster", () => ({ toast: { error: vi.fn() } }));
vi.mock("posthog-js", () => ({ default: { captureException: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const fetchMock = vi.fn();

const respondWith = (status: number) =>
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify({ detail: "nope" }), { status }),
	);

const signedInAs = (id: string | null) =>
	vi
		.mocked(useCurrentUser)
		.mockReturnValue({ data: id ? { id } : null } as ReturnType<
			typeof useCurrentUser
		>);

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("announcement error reporting", () => {
	it.each([401, 403])(
		"does not report a %i, which is an ended session",
		async (status) => {
			signedInAs("user-1");
			respondWith(status);
			const query = renderHook(() => useInfiniteAnnouncements({}), { wrapper });
			await waitFor(() => expect(query.result.current.isError).toBe(true));
			expect(posthog.captureException).not.toHaveBeenCalled();
		},
	);

	it("reports a server failure", async () => {
		signedInAs("user-1");
		respondWith(500);
		const query = renderHook(() => useInfiniteAnnouncements({}), { wrapper });
		await waitFor(() => expect(query.result.current.isError).toBe(true));
		expect(posthog.captureException).toHaveBeenCalledTimes(1);
	});
});

describe("what's new", () => {
	it("does not fetch without a signed-in user", async () => {
		signedInAs(null);
		const query = renderHook(() => useWhatsNewAnnouncements(), { wrapper });
		await waitFor(() => expect(query.result.current.fetchStatus).toBe("idle"));
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
