// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it } from "vitest";
import { useUrlSearch } from "./useUrlSearch";

// The search box writes its text to the address, and drops it when emptied.
const wrapper = ({ children }: { children: ReactNode }) => (
	<MemoryRouter initialEntries={["/projects?search=town&tab=all"]}>
		{children}
	</MemoryRouter>
);
const useBoth = () => ({ location: useLocation(), search: useUrlSearch() });

it("reads, writes and clears the search in the address", () => {
	const { result } = renderHook(useBoth, { wrapper });
	expect(result.current.search[0]).toBe("town");

	act(() => result.current.search[1]("city"));
	expect(result.current.search[0]).toBe("city");
	expect(result.current.location.search).toBe("?search=city&tab=all");

	act(() => result.current.search[1](""));
	expect(result.current.location.search).toBe("?tab=all");
});

it("keeps its setter while the address is the same", () => {
	const { result, rerender } = renderHook(useBoth, { wrapper });
	const setSearch = result.current.search[1];
	rerender();
	expect(result.current.search[1]).toBe(setSearch);
});
