// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultReadyTime, LiveButton, readyByFrom } from "./LiveButton";
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
	it("reads a booked start after who can see it", () => {
		const readyBy = new Date(Date.now() + 2 * 3600_000);
		const startsAt = new Date(readyBy.getTime() - 15 * 60_000);
		show(
			<StatusLine
				isPublic
				booking={{
					readyBy: readyBy.toISOString(),
					startsAt: startsAt.toISOString(),
				}}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe(
			`Public page·Popcorn ready by ${formatWhen(readyBy, "en")}·starts ${formatWhen(startsAt, "en")}`,
		);
	});
	it("says private, with nothing live", () => {
		show(<StatusLine isPublic={false} />);
		expect(screen.getByRole("status").textContent).toBe("Private");
	});
});

describe("readyByFrom", () => {
	it("means today, or tomorrow once the time has passed", () => {
		const now = new Date(2026, 9, 6, 13, 0);
		expect(readyByFrom("14:30", now)).toEqual(new Date(2026, 9, 6, 14, 30));
		expect(readyByFrom("09:00", now)).toEqual(new Date(2026, 9, 7, 9, 0));
		expect(readyByFrom("", now)).toBeNull();
		expect(readyByFrom("25:00", now)).toBeNull();
	});
	it("suggests the first full hour at least half an hour away", () => {
		expect(defaultReadyTime(new Date(2026, 9, 6, 13, 20))).toBe("14:00");
		expect(defaultReadyTime(new Date(2026, 9, 6, 13, 40))).toBe("15:00");
	});
});

describe("LiveButton", () => {
	const button = (props: Partial<Parameters<typeof LiveButton>[0]> = {}) =>
		show(
			<LiveButton
				live={false}
				pending={false}
				onGoLive={vi.fn()}
				onReadyBy={vi.fn()}
				onStop={vi.fn()}
				{...props}
			/>,
		);

	it("offers Start now and Ready by above the hours", async () => {
		button();
		fireEvent.click(screen.getByRole("button", { name: "Go live" }));
		const items = (await screen.findAllByRole("menuitem")).map(
			(item) => item.textContent,
		);
		expect(items).toEqual(["Start now", "1 hour", "8 hours", "24 hours"]);
		expect(
			screen.getByRole("menuitem", { name: "8 hours Selected" }),
		).toBeTruthy();
		expect(screen.getByLabelText("Ready by")).toBeTruthy();
	});

	it("starts now for 8 hours, or for the hours chosen", async () => {
		const onGoLive = vi.fn();
		button({ onGoLive });
		fireEvent.click(screen.getByRole("button", { name: "Go live" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Start now" }));
		expect(onGoLive).toHaveBeenLastCalledWith(8);
		fireEvent.click(screen.getByRole("button", { name: "Go live" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "24 hours" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Start now" }));
		expect(onGoLive).toHaveBeenLastCalledWith(24);
	});

	it("says when the first read starts, and books the time", async () => {
		// Pinned to the morning so 14:30 is still ahead with its early start.
		vi.useFakeTimers({ toFake: ["Date"] });
		const morning = new Date();
		morning.setHours(9, 0, 0, 0);
		vi.setSystemTime(morning);
		const onReadyBy = vi.fn();
		button({ onReadyBy });
		fireEvent.click(screen.getByRole("button", { name: "Go live" }));
		fireEvent.change(await screen.findByLabelText("Ready by"), {
			target: { value: "14:30" },
		});
		const readyBy = readyByFrom("14:30") as Date;
		const startsAt = new Date(readyBy.getTime() - 15 * 60_000);
		expect(screen.getByText(/15 minutes early$/).textContent).toBe(
			`Starts at ${formatWhen(startsAt, "en")}, 15 minutes early`,
		);
		fireEvent.click(screen.getByRole("button", { name: "Book" }));
		expect(onReadyBy).toHaveBeenCalledWith(8, readyBy);
		vi.useRealTimers();
	});

	it("says it starts now when the time is under 15 minutes away", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const nearly = new Date();
		nearly.setHours(14, 20, 0, 0);
		vi.setSystemTime(nearly);
		button({});
		fireEvent.click(screen.getByRole("button", { name: "Go live" }));
		fireEvent.change(await screen.findByLabelText("Ready by"), {
			target: { value: "14:30" },
		});
		expect(screen.getByText("Starts now")).toBeTruthy();
		vi.useRealTimers();
	});

	it("shows a booked start on the button, with Cancel in the menu", async () => {
		const onStop = vi.fn();
		const readyBy = new Date(Date.now() + 2 * 3600_000);
		button({
			booking: {
				readyBy: readyBy.toISOString(),
				startsAt: new Date(readyBy.getTime() - 15 * 60_000).toISOString(),
			},
			onStop,
		});
		expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name: `Ready by ${formatWhen(readyBy, "en")}`,
			}),
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: "Cancel" }));
		expect(onStop).toHaveBeenCalled();
	});

	it("puts Stop live in Go live's place while live", () => {
		const onStop = vi.fn();
		button({ live: true, onStop });
		expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Stop live" }));
		expect(onStop).toHaveBeenCalled();
	});
});
