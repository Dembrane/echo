// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SUGGESTIONS } from "../setupSuggestions.fixture";
import { Providers, setUpDom } from "../testing";
import { SuggestedSettings } from "./SuggestedSettings";

afterEach(cleanup);
beforeAll(setUpDom);

describe("SuggestedSettings", () => {
	it("one unticked checkbox per setting, named as the portal editor names it, with its reason and both values", () => {
		const onToggle = vi.fn();
		render(
			<Providers>
				<SuggestedSettings
					settings={SUGGESTIONS.settings}
					checked={{}}
					onToggle={onToggle}
				/>
			</Providers>,
		);
		const verify = screen.getByRole("checkbox", {
			name: "Participant verification",
		}) as HTMLInputElement;
		expect(verify.checked).toBe(false);
		expect(
			screen.getByText("Je wilt dat iedere tafel de afspraken bevestigt."),
		).toBeTruthy();
		const name = screen.getAllByRole("group", {
			name: "From the template to the suggestion",
		})[0];
		expect(name?.textContent).toBe("offon");
		fireEvent.click(verify);
		expect(onToggle).toHaveBeenCalledWith("is_verify_enabled", true);
	});

	it("names tutorial values in the portal editor's words", () => {
		render(
			<Providers>
				<SuggestedSettings
					settings={[
						{
							current: "None",
							field: "default_conversation_tutorial_slug",
							proposed: "advanced",
							reason: "Many phones at once.",
						},
					]}
					checked={{}}
					onToggle={() => {}}
				/>
			</Providers>,
		);
		expect(
			screen.getByRole("group", { name: "From the template to the suggestion" })
				.textContent,
		).toBe("No tutorialAdvanced tutorial");
	});

	it("shows what the host ticked", () => {
		render(
			<Providers>
				<SuggestedSettings
					settings={SUGGESTIONS.settings}
					checked={{ is_verify_enabled: true }}
					onToggle={() => {}}
				/>
			</Providers>,
		);
		expect(
			(
				screen.getByRole("checkbox", {
					name: "Participant verification",
				}) as HTMLInputElement
			).checked,
		).toBe(true);
	});
});
