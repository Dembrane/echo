// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ResultRowActions } from "./ResultRowActions";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia = vi.fn().mockImplementation((media) => ({
		addEventListener() {},
		matches: false,
		media,
		removeEventListener() {},
	}));
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function show(props: Parameters<typeof ResultRowActions>[0]) {
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ResultRowActions {...props} />
			</MantineProvider>
		</I18nProvider>,
	);
}

describe("Acting on one row of results", () => {
	it("offers only the actions the table passes, each named in words", () => {
		const onEdit = vi.fn();
		const onToggleHidden = vi.fn();
		show({ onEdit, onToggleHidden });
		fireEvent.click(
			screen.getByRole("button", {
				name: "Edit wording, see evidence and history",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Hide from this presentation" }),
		);
		expect(onEdit).toHaveBeenCalledOnce();
		expect(onToggleHidden).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "This is right" })).toBeNull();
		expect(screen.queryByRole("button", { name: "This is wrong" })).toBeNull();
	});

	it("names the way back for a hidden result", () => {
		show({ hidden: true, onToggleHidden: vi.fn() });
		expect(
			screen.getByRole("button", { name: "Show in this presentation" }),
		).toBeTruthy();
	});

	it("keeps a slot for thumbs up and down once voting is decided", () => {
		const onVote = vi.fn();
		show({ onVote, vote: "up" });
		fireEvent.click(screen.getByRole("button", { name: "This is wrong" }));
		expect(onVote).toHaveBeenCalledWith("down");
		expect(screen.queryByRole("button", { name: /Edit wording/ })).toBeNull();
	});
});
