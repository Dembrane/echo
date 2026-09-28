// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAP_SETTINGS } from "../state/settings";
import { Legend } from "./Legend";

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(cleanup);

const renderLegend = (props: Parameters<typeof Legend>[0]) =>
	render(
		<I18nProvider i18n={i18n}>
			<Legend {...props} />
		</I18nProvider>,
	);

describe("the conversation legend", () => {
	it("is on from the start, now that the colours stand for conversations", () => {
		expect(DEFAULT_MAP_SETTINGS.showLegend).toBe(true);
		expect(DEFAULT_MAP_SETTINGS.colorBy).toBe("conversation");
	});

	it("numbers the conversations where it has no names", () => {
		renderLegend({
			colorBy: "conversation",
			conversations: 2,
			darkMode: false,
		});
		expect(screen.getByText("Conversation 1")).toBeTruthy();
		expect(screen.getByText("Conversation 2")).toBeTruthy();
	});

	it("names the ones it has a name for, and numbers the rest", () => {
		renderLegend({
			colorBy: "conversation",
			conversations: 3,
			darkMode: false,
			names: new Map([
				[0, "Ada"],
				[2, "Ben"],
			]),
		});
		expect(screen.getByText("Ada")).toBeTruthy();
		expect(screen.getByText("Conversation 2")).toBeTruthy();
		expect(screen.getByText("Ben")).toBeTruthy();
	});

	it("counts the conversations it does not list", () => {
		renderLegend({
			colorBy: "conversation",
			conversations: 11,
			darkMode: false,
		});
		expect(screen.getByText("and 3 more conversations")).toBeTruthy();
	});
});
