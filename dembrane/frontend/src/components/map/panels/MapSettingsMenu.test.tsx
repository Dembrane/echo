// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAP_SETTINGS } from "../state/settings";
import {
	MapFilterMenu,
	type MapConversation,
	MapSettingsMenu,
} from "./MapSettingsMenu";

i18n.load("en-US", {});
i18n.activate("en-US");

beforeAll(() => {
	// The lists scroll inside a Mantine ScrollArea, which measures itself.
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
});

afterEach(cleanup);

const open = (tags: MapConversation[], onChosenTagsChange = vi.fn()) => {
	render(
		<MantineProvider>
			<I18nProvider i18n={i18n}>
				<MapFilterMenu
					withinPortal={false}
					tags={tags}
					chosenTags={new Set()}
					onChosenTagsChange={onChosenTagsChange}
				/>
				<MapSettingsMenu
					settings={DEFAULT_MAP_SETTINGS}
					onChange={vi.fn()}
					colorBy="conversation"
					onColorByChange={vi.fn()}
					canFactCheck={false}
					withinPortal={false}
					tags={tags}
				/>
			</I18nProvider>
		</MantineProvider>,
	);
	return onChosenTagsChange;
};
const openMenu = (name: "Filter" | "Settings") =>
	fireEvent.click(screen.getByRole("button", { name }));

describe("the map's tag controls", () => {
	it("filter by tag under Filter, and colour by tag under Settings", async () => {
		const onChosen = open([{ color: "#fff", id: "t-age", name: "Age" }]);
		openMenu("Filter");
		fireEvent.click(await screen.findByRole("checkbox", { name: "Age" }));
		expect(onChosen).toHaveBeenCalledWith(new Set(["t-age"]));
		openMenu("Settings");
		expect(await screen.findByRole("radio", { name: "Tag" })).toBeTruthy();
	});

	it("leave the view and the forces to Settings where there is no toolbar", async () => {
		open([]);
		openMenu("Settings");
		expect(
			await screen.findByRole("radio", { name: "Side by side" }),
		).toBeTruthy();
		expect(
			screen.getByRole("checkbox", { name: "Force settings" }),
		).toBeTruthy();
	});

	it("are absent where it has none, and so is Filter", async () => {
		open([]);
		expect(screen.queryByRole("button", { name: "Filter" })).toBeNull();
		openMenu("Settings");
		await screen.findByRole("radio", { name: "Valence" });
		expect(screen.queryByRole("radio", { name: "Tag" })).toBeNull();
	});
});
