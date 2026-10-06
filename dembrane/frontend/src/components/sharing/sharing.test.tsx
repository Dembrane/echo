// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LiveButton } from "./LiveButton";
import { formatWhen, StatusLine } from "./StatusLine";

i18n.loadAndActivate({ locale: "en", messages: {} });

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query) => ({
		addEventListener() {},
		matches: false,
		media: query,
		removeEventListener() {},
	}));
	globalThis.ResizeObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
	};
});

afterEach(cleanup);

const show = (ui: React.ReactNode) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>{ui}</MantineProvider>
		</I18nProvider>,
	);

describe("formatWhen", () => {
	it("says only the time today, and the day too otherwise", () => {
		const now = new Date(2026, 9, 4, 12, 0);
		expect(formatWhen(new Date(2026, 9, 4, 18, 0), "en-GB", now)).toBe("18:00");
		expect(formatWhen(new Date(2026, 9, 5, 9, 0), "en-GB", now)).toBe(
			"Mon 5 Oct, 09:00",
		);
	});
});

describe("StatusLine", () => {
	it("reads live first, then who can see it", () => {
		show(
			<StatusLine
				live
				liveUntil={new Date(Date.now() + 3600_000).toISOString()}
				isPublic
				extra={["Unpublished changes"]}
			/>,
		);
		const line = screen.getByRole("status").textContent ?? "";
		expect(line).toMatch(/^Live until .+·Public page·Unpublished changes$/);
	});
	it("says private, with nothing live", () => {
		show(<StatusLine isPublic={false} />);
		expect(screen.getByRole("status").textContent).toBe("Private");
	});
});

describe("LiveButton", () => {
	it("goes live for the hours chosen, in one click", async () => {
		const onGoLive = vi.fn();
		show(
			<LiveButton
				live={false}
				pending={false}
				onGoLive={onGoLive}
				onStop={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Go live" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "8 hours" }));
		expect(onGoLive).toHaveBeenCalledWith(8);
	});
	it("puts Stop live in Go live's place while live", () => {
		const onStop = vi.fn();
		show(
			<LiveButton live pending={false} onGoLive={vi.fn()} onStop={onStop} />,
		);
		expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Stop live" }));
		expect(onStop).toHaveBeenCalled();
	});
});
