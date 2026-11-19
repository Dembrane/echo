// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
	SIDEBAR_WIDTH_MAX,
	SIDEBAR_WIDTH_MIN,
	useSidebarState,
} from "./useSidebarState";

// The sidebar's width, collapse and open tree nodes, kept in localStorage.
afterEach(() => localStorage.clear());

it("keeps its handlers across renders", () => {
	const { result, rerender } = renderHook(useSidebarState);
	const first = result.current;
	rerender();
	expect(result.current.setWidth).toBe(first.setWidth);
	expect(result.current.toggleNode).toBe(first.toggleNode);
	expect(result.current.setNodeExpanded).toBe(first.setNodeExpanded);
});

it("clamps and stores the width, and reads 0 while collapsed", () => {
	const { result } = renderHook(useSidebarState);
	act(() => result.current.setWidth(10_000));
	expect(result.current.width).toBe(SIDEBAR_WIDTH_MAX);
	act(() => result.current.setWidth(0));
	expect(result.current.width).toBe(SIDEBAR_WIDTH_MIN);
	expect(localStorage.getItem("dembrane.sidebar.width")).toBe(
		String(SIDEBAR_WIDTH_MIN),
	);
	act(() => result.current.setCollapsed(true));
	expect(result.current.width).toBe(0);
});

it("opens and closes tree nodes, and another sidebar hears it", async () => {
	const { result } = renderHook(useSidebarState);
	const other = renderHook(useSidebarState);
	act(() => result.current.toggleNode("ws-1"));
	expect(result.current.isNodeExpanded("ws-1")).toBe(true);
	await act(async () => {});
	expect(other.result.current.isNodeExpanded("ws-1")).toBe(true);
	act(() => result.current.setNodeExpanded("ws-1", false));
	expect(result.current.isNodeExpanded("ws-1")).toBe(false);
});
