// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import {
	applyMapUrlState,
	deduplicationResultScope,
	parseMapSearchParams,
	useMapUrlState,
} from "./useMapUrlState";

describe("parseMapSearchParams", () => {
	it("reads types, scope, colour mode and view", () => {
		expect(
			parseMapSearchParams(
				new URLSearchParams(
					"types=tension,argument,bogus&scope=run-1&colorBy=valence&view=list",
				),
			),
		).toEqual({
			colorBy: "valence",
			scope: "run-1",
			// Filter order, unknown types dropped.
			types: ["argument", "tension"],
			view: "list",
		});
	});

	it("tells an absent selection from an empty one", () => {
		expect(parseMapSearchParams(new URLSearchParams("")).types).toBeNull();
		expect(parseMapSearchParams(new URLSearchParams("types=")).types).toEqual(
			[],
		);
	});

	it("ignores an unknown colour mode or view", () => {
		expect(
			parseMapSearchParams(new URLSearchParams("colorBy=rainbow&view=grid")),
		).toMatchObject({ colorBy: null, view: null });
	});
});

describe("applyMapUrlState", () => {
	it("keeps other parameters and removes cleared ones", () => {
		const next = applyMapUrlState(
			new URLSearchParams("fixture=mixed&scope=run-1"),
			{ colorBy: "type", scope: null, types: ["tension"] },
		);
		expect(next.get("fixture")).toBe("mixed");
		expect(next.get("scope")).toBeNull();
		expect(next.get("types")).toBe("tension");
		expect(next.get("colorBy")).toBe("type");
	});

	it("opens a deduplication result on its output only", () => {
		const next = applyMapUrlState(
			new URLSearchParams(""),
			deduplicationResultScope("dedup-run-7"),
		);
		expect(parseMapSearchParams(next)).toMatchObject({
			scope: "dedup-run-7",
			types: ["deduplicated_argument"],
		});
	});
});

describe("useMapUrlState", () => {
	const hook = (initial: string) =>
		renderHook(() => ({ location: useLocation(), url: useMapUrlState() }), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
			),
		});

	it("writes through the router and reads back the same state after a reload", () => {
		const first = hook("/map?fixture=mixed");
		act(() => {
			first.result.current.url[1]({
				colorBy: "factCheck",
				scope: "dedup-run-7",
				types: ["deduplicated_argument", "tension"],
			});
		});
		const search = first.result.current.location.search;
		expect(first.result.current.url[0]).toEqual({
			colorBy: "factCheck",
			scope: "dedup-run-7",
			types: ["deduplicated_argument", "tension"],
			view: null,
		});

		// A reload starts from the URL alone.
		const reloaded = hook(`/map${search}`);
		expect(reloaded.result.current.url[0]).toEqual(first.result.current.url[0]);
		expect(new URLSearchParams(search).get("fixture")).toBe("mixed");
	});
});
