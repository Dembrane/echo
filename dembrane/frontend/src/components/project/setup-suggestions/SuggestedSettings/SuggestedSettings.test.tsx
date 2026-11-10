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
		const tutorial = screen.getAllByRole("group", {
			name: "From the template to the suggestion",
		})[1];
		expect(tutorial?.textContent).toBe("No tutorialAdvanced tutorial");
		fireEvent.click(verify);
		expect(onToggle).toHaveBeenCalledWith("is_verify_enabled", true);
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
