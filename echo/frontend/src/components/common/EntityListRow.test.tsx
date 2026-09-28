// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import { EntityListRow } from "./EntityListRow";

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		addEventListener: vi.fn(),
		addListener: vi.fn(),
		dispatchEvent: vi.fn(),
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: vi.fn(),
		removeListener: vi.fn(),
	}));
});

it("activates an interactive row from the keyboard", () => {
	const onActivate = vi.fn();
	render(
		<MantineProvider>
			<EntityListRow ariaLabel="Open result" onActivate={onActivate}>
				Result <button type="button">Row action</button>
			</EntityListRow>
		</MantineProvider>,
	);

	const row = screen.getByRole("button", { name: "Open result" });
	fireEvent.keyDown(row, { key: "Enter" });
	fireEvent.keyDown(row, { key: " " });
	fireEvent.keyDown(screen.getByRole("button", { name: "Row action" }), {
		key: "Enter",
	});

	expect(onActivate).toHaveBeenCalledTimes(2);
});
