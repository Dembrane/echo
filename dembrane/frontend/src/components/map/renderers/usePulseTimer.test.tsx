// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { d3, type Selection } from "./d3";
import { usePulseTimer } from "./hooks";

type Pulse = Selection<SVGCircleElement, unknown, SVGGElement, unknown>;

afterEach(() => {
	document.body.innerHTML = "";
});

// Two circles in an svg group, selected the way the renderers select them.
const circles = () => {
	const svg = d3.select(document.body).append("svg");
	const group = svg.append("g");
	group.append("circle");
	group.append("circle");
	return group.selectAll<SVGCircleElement, unknown>("circle") as Pulse;
};

describe("usePulseTimer", () => {
	it("hands back the same start function on every render", () => {
		const ref = createRef<Pulse | null>() as { current: Pulse | null };
		const { rerender, result } = renderHook(() => usePulseTimer(ref));
		const start = result.current;
		rerender();
		rerender();
		expect(result.current).toBe(start);
	});

	it("pulses the circles, and stops once nothing pulses", async () => {
		const ref = { current: circles() as Pulse | null };
		const { result } = renderHook(() => usePulseTimer(ref));

		result.current();
		await waitFor(() =>
			expect(
				document.querySelector("circle")?.getAttribute("opacity"),
			).toBeTruthy(),
		);

		// Nothing left to pulse: the timer lets go, and a later start starts it again.
		const first = document.querySelector("circle");
		ref.current = null;
		await new Promise((resolve) => setTimeout(resolve, 50));
		first?.removeAttribute("opacity");
		ref.current = circles();
		result.current();
		await waitFor(() =>
			expect(
				document.querySelectorAll("circle")[2]?.getAttribute("opacity"),
			).toBeTruthy(),
		);
		expect(first?.getAttribute("opacity")).toBeNull();
	});
});
