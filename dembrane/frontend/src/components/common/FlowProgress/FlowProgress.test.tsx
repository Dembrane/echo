// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	Providers,
	setUpDom,
} from "@/components/project/setup-suggestions/testing";
import { FlowProgress } from "./FlowProgress";

beforeAll(setUpDom);
afterEach(cleanup);

describe("FlowProgress", () => {
	it("is a progress bar that says which step of how many", () => {
		render(
			<Providers>
				<FlowProgress step={2} total={5} />
			</Providers>,
		);
		const bar = screen.getByRole("progressbar", { name: "Step 2 of 5" });
		expect(bar.getAttribute("aria-valuenow")).toBe("2");
		expect(bar.getAttribute("aria-valuemax")).toBe("5");
		expect((bar.firstElementChild as HTMLElement).style.width).toBe("40%");
	});

	it("keeps the step inside the flow", () => {
		render(
			<Providers>
				<FlowProgress step={9} total={3} />
			</Providers>,
		);
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
			"3",
		);
	});
});
