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
import type {
	PopcornDetail,
	PopcornLanguage,
} from "@/components/popcorn/hooks";
import { PopcornLanguageSettings } from "./PopcornLanguageSettings";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/components/popcorn/hooks", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/components/popcorn/hooks")>();
	return {
		...actual,
		usePopcornSettingsMutation: () => ({ isPending: false, mutate }),
	};
});

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

const popcorn = (language: PopcornLanguage): PopcornDetail =>
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
			language,
			notice: { enabled: true, text: "" },
			public: false,
			public_labels: "neutral",
			show_branding: true,
			show_qr: true,
			tabs: { stakeholders: false, tensions: false },
			title: "Workshop",
			voice: { note: "", presets: [] },
		},
	}) as PopcornDetail;

const view = (language: PopcornLanguage) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<PopcornLanguageSettings
					popcorn={popcorn(language)}
					projectId="project-1"
				/>
			</MantineProvider>
		</I18nProvider>,
	);

// Mantine passes unknown props straight to the input element.
const openField = (id: string) => {
	const input = screen.getByTestId(id);
	fireEvent.click(input);
	return input;
};

describe("The languages a popcorn also pops in", () => {
	it("stays away until the screen is translated at all", () => {
		view({ translate_to: "", ui: "auto" });
		expect(screen.queryByTestId("popcorn-language-also")).toBeNull();
	});

	it("appears once a language to translate into is chosen", () => {
		view({ translate_to: "nl", ui: "auto" });
		expect(screen.getByTestId("popcorn-language-also")).toBeTruthy();
		expect(screen.getByText("Popcorn also in")).toBeTruthy();
	});

	it("replaces the whole list in one patch when a language is picked", () => {
		view({ translate_to: "nl", ui: "auto" });
		openField("popcorn-language-also");
		fireEvent.click(screen.getByRole("option", { name: "Français" }));
		expect(mutate).toHaveBeenCalledExactlyOnceWith({
			language: { also: ["fr"] },
		});
	});

	it("does not offer the language everything is already translated into", () => {
		view({ translate_to: "nl", ui: "auto" });
		openField("popcorn-language-also");
		expect(screen.queryByRole("option", { name: "Nederlands" })).toBeNull();
		expect(screen.getByRole("option", { name: "Deutsch" })).toBeTruthy();
	});

	it("stops at three extra languages", () => {
		view({ also: ["fr", "de", "es"], translate_to: "nl", ui: "auto" });
		openField("popcorn-language-also");
		fireEvent.click(screen.getByRole("option", { name: "Italiano" }));
		expect(mutate).not.toHaveBeenCalled();
		// The three already chosen can still be taken off again.
		fireEvent.click(screen.getByRole("option", { name: "Français" }));
		expect(mutate).toHaveBeenCalledExactlyOnceWith({
			language: { also: ["de", "es"] },
		});
	});

	it("drops an extra language that becomes the primary target, in the same save", () => {
		view({ also: ["fr", "de"], translate_to: "nl", ui: "auto" });
		openField("popcorn-language-translate");
		fireEvent.click(
			screen.getByRole("option", { name: "Translate to Français" }),
		);
		expect(mutate).toHaveBeenCalledExactlyOnceWith({
			language: { also: ["de"], translate_to: "fr" },
		});
	});
});
