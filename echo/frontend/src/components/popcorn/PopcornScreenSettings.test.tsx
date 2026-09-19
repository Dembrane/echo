// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { PopcornDetail } from "@/components/popcorn/hooks";
import { PopcornScreenSettings } from "./PopcornScreenSettings";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/components/popcorn/hooks", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/components/popcorn/hooks")>();
	return {
		...actual,
		usePopcornSettingsMutation: () => ({ isPending: false, mutate }),
	};
});

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspace: { tier: "free" } }),
}));

i18n.load("en", {});
i18n.activate("en");

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

beforeEach(() => {
	mutate.mockReset();
});

afterEach(cleanup);

const popcorn = (theme?: "light" | "dark"): PopcornDetail =>
	({
		counts: {
			conversations: 0,
			conversations_read: 0,
			phrases: 0,
			quotes: 0,
			stakeholders: 0,
			tensions: 0,
		},
		id: "pop-1",
		kind: "popcorn",
		name: "Workshop",
		settings: {
			client: "",
			data: { enabled: true },
			disclosure: {
				enabled: true,
				invitation_text: "",
				invitation_title: "",
				text: "",
			},
			intro: { enabled: true, subtitle: "", title: "" },
			notice: { enabled: true, text: "" },
			public: false,
			public_labels: "neutral",
			show_branding: true,
			show_qr: true,
			tabs: { stakeholders: false, tensions: false },
			theme,
			title: "Workshop",
			voice: { note: "", presets: [] },
		},
	}) as PopcornDetail;

const view = (theme?: "light" | "dark") =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<PopcornScreenSettings popcorn={popcorn(theme)} projectId="project-1" />
			</MantineProvider>
		</I18nProvider>,
	);

const checked = () =>
	screen
		.getByTestId("popcorn-theme-control")
		.querySelector<HTMLInputElement>("input:checked")?.value;

describe("The theme the host picks for the room", () => {
	it("shows light when the server has never been told otherwise", () => {
		view(undefined);
		expect(screen.getByText("Screen theme")).toBeTruthy();
		expect(checked()).toBe("light");
	});

	it("shows the theme already saved", () => {
		view("dark");
		expect(checked()).toBe("dark");
	});

	it("saves the chosen theme on its own", () => {
		view("light");
		fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
		expect(mutate).toHaveBeenCalledExactlyOnceWith({ theme: "dark" });
	});

	it("goes back to light from dark", () => {
		view("dark");
		fireEvent.click(screen.getByRole("radio", { name: "Light" }));
		expect(mutate).toHaveBeenCalledExactlyOnceWith({ theme: "light" });
	});
});
