// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAP_SETTINGS } from "../state/settings";
import { type MapConversation, MapSettingsMenu } from "./MapSettingsMenu";

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
				<MapSettingsMenu
					settings={DEFAULT_MAP_SETTINGS}
					onChange={vi.fn()}
					colorBy="conversation"
					onColorByChange={vi.fn()}
					canFactCheck={false}
					withinPortal={false}
					tags={tags}
					chosenTags={new Set()}
					onChosenTagsChange={onChosenTagsChange}
				/>
			</I18nProvider>
		</MantineProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Panel settings" }));
	return onChosenTagsChange;
};

describe("the map's tag controls", () => {
	it("offer the tags and colouring by tag where the map has tags", async () => {
		const onChosen = open([{ color: "#fff", id: "t-age", name: "Age" }]);
		expect(await screen.findByRole("radio", { name: "Tag" })).toBeTruthy();
		fireEvent.click(screen.getByRole("checkbox", { name: "Age" }));
		expect(onChosen).toHaveBeenCalledWith(new Set(["t-age"]));
	});

	it("are absent where it has none", async () => {
		open([]);
		await screen.findByRole("radio", { name: "Valence" });
		expect(screen.queryByRole("radio", { name: "Tag" })).toBeNull();
		expect(screen.queryByText("Tags")).toBeNull();
	});
});
