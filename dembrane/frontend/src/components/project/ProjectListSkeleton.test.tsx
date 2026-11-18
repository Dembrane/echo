// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectListSkeleton } from "./ProjectListSkeleton";

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query) => ({
		addEventListener() {},
		matches: false,
		media: query,
		removeEventListener() {},
	}));
});
afterEach(cleanup);

const renderSkeleton = (props: ComponentProps<typeof ProjectListSkeleton>) => {
	const view = render(
		<MantineProvider>
			<ProjectListSkeleton {...props} />
		</MantineProvider>,
	);
	const skeletons = () =>
		Array.from(view.container.querySelectorAll(".mantine-Skeleton-root"));
	const rerender = (next: ComponentProps<typeof ProjectListSkeleton>) =>
		view.rerender(
			<MantineProvider>
				<ProjectListSkeleton {...next} />
			</MantineProvider>,
		);
	return { rerender, skeletons, view };
};

describe("ProjectListSkeleton", () => {
	it("shows the search bar placeholder and six rows by default", () => {
		const { skeletons } = renderSkeleton({ searchValue: "" });
		// 1 search bar + 6 rows
		expect(skeletons()).toHaveLength(7);
	});

	it("leaves out the search bar placeholder while searching", () => {
		const { skeletons } = renderSkeleton({ count: 3, searchValue: "warm" });
		expect(skeletons()).toHaveLength(3);
	});

	it("renders bare rows without the layout for pagination", () => {
		const { skeletons, view } = renderSkeleton({
			count: 2,
			searchValue: "",
			wrapper: false,
		});
		expect(skeletons()).toHaveLength(2);
		expect(view.container.querySelector(".mantine-Stack-root")).toBeNull();
	});

	it("keeps the same rows mounted when the search changes", () => {
		const { rerender, skeletons } = renderSkeleton({
			count: 3,
			searchValue: "warm",
		});
		const before = skeletons();
		rerender({ count: 3, searchValue: "warmte" });
		const after = skeletons();
		expect(after).toHaveLength(3);
		after.forEach((node, i) => {
			expect(node).toBe(before[i]);
		});
	});
});
