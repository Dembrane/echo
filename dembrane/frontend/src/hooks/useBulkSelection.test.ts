// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useBulkSelection } from "./useBulkSelection";

// Picks rows for a bulk move. Its handlers stay the same across renders, so
// a row or an effect that holds one does not see a new function each time.
const ids = ["a", "b", "c"];

it("keeps its handlers while the list is the same", () => {
	const { result, rerender } = renderHook(() => useBulkSelection(ids));
	const first = result.current;
	rerender();
	expect(result.current.toggle).toBe(first.toggle);
	expect(result.current.toggleAll).toBe(first.toggleAll);
	expect(result.current.clear).toBe(first.clear);
});

it("selects all, then clears, from the header checkbox", () => {
	const { result } = renderHook(() => useBulkSelection(ids));
	act(() => result.current.toggle("a"));
	expect(result.current.someSelected).toBe(true);
	act(() => result.current.toggleAll());
	expect(result.current.allSelected).toBe(true);
	act(() => result.current.toggleAll());
	expect(result.current.count).toBe(0);
});

it("counts only selected rows that are still in the list", () => {
	const { result, rerender } = renderHook(
		({ list }) => useBulkSelection(list),
		{
			initialProps: { list: ids },
		},
	);
	act(() => result.current.toggle("a"));
	act(() => result.current.toggle("c"));
	rerender({ list: ["a", "b"] });
	expect(result.current.selectedIds).toEqual(["a"]);
	expect(result.current.isSelected("a")).toBe(true);
});
