// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@/hooks/useServerEvents";
import type { FactCheckState } from "../types";
import {
	FACT_CHECK_REFETCH_DELAY_MS,
	isNewerFactCheck,
	mapKeys,
	type ProjectMapState,
	useMapEvents,
} from "./index";

const events = vi.hoisted(() => ({
	onEvent: null as ((event: ServerEvent) => void) | null,
}));

vi.mock("@/hooks/useServerEvents", () => ({
	useServerEvents: (
		_url: string | null,
		_types: readonly string[],
		onEvent: (event: ServerEvent) => void,
	) => {
		events.onEvent = onEvent;
	},
}));

vi.mock("@/lib/bff", () => ({ bff: { get: vi.fn() } }));
vi.mock("@/components/common/Toaster", () => ({
	toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

describe("useMapEvents", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		events.onEvent = null;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("refetches only the current result's fact-checks, once per burst", () => {
		const client = new QueryClient();
		client.setQueryData<ProjectMapState>(mapKeys.project("p1"), {
			attempt: null,
			current: { id: "r1" } as ProjectMapState["current"],
		});
		const invalidate = vi.spyOn(client, "invalidateQueries");
		renderHook(() => useMapEvents("p1"), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>{children}</QueryClientProvider>
			),
		});

		for (let index = 0; index < 5; index += 1) {
			events.onEvent?.({ claim_key: `k${index}`, type: "fact_check" });
			vi.advanceTimersByTime(40);
		}
		expect(invalidate).not.toHaveBeenCalled();

		vi.advanceTimersByTime(FACT_CHECK_REFETCH_DELAY_MS);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: mapKeys.factChecks("r1"),
		});

		// A later event starts a new window.
		events.onEvent?.({ claim_key: "k9", type: "fact_check" });
		vi.advanceTimersByTime(FACT_CHECK_REFETCH_DELAY_MS);
		expect(invalidate).toHaveBeenCalledTimes(2);
	});
});

describe("isNewerFactCheck", () => {
	const processing: FactCheckState = {
		startedAt: "2026-09-15T10:00:00Z",
		status: "processing",
	};
	const finished: FactCheckState = {
		checkedAt: "2026-09-15T10:00:05Z",
		justification: "",
		sources: [],
		status: "done",
		verdict: "true",
	};

	it("compares server times, with a finished check outranking its start", () => {
		expect(isNewerFactCheck(finished, processing)).toBe(true);
		expect(isNewerFactCheck(processing, finished)).toBe(false);
		expect(
			isNewerFactCheck(
				{ ...finished, checkedAt: processing.startedAt },
				processing,
			),
		).toBe(true);
		// A re-check started after an old verdict replaces it.
		expect(
			isNewerFactCheck(finished, {
				startedAt: "2026-09-15T11:00:00Z",
				status: "processing",
			}),
		).toBe(false);
		expect(isNewerFactCheck({ status: "idle" }, processing)).toBe(false);
		expect(isNewerFactCheck(undefined, processing)).toBe(false);
	});
});
