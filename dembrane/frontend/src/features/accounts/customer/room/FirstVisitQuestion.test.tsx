// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RoomLabelT } from "../../contract/contract.gen";

// The first-visit question, asked once of someone brought in by someone else
// (me.labels_question): FirstVisitQuestion({ inviter, labels, other, onAnswer }).
const load = async () =>
	(await import("./FirstVisitQuestion")).FirstVisitQuestion;

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia ??= ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

type Answer = (body: {
	labels: RoomLabelT[];
	other: string | null;
}) => Promise<unknown>;

const show = async (labels: RoomLabelT[], other: string | null = null) => {
	const FirstVisitQuestion = await load();
	let settle: () => void = () => {};
	const onAnswer = vi.fn<Answer>(
		() =>
			new Promise((resolve) => {
				settle = () => resolve({});
			}),
	);
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<FirstVisitQuestion
					inviter="Anna Bakker"
					labels={labels}
					other={other}
					onAnswer={onAnswer}
				/>
			</MantineProvider>
		</I18nProvider>,
	);
	return { onAnswer, settle: () => settle() };
};

describe("the first-visit question", () => {
	it("asks in one sentence whether what they were invited to do is right", async () => {
		await show(["rollout"]);
		expect(screen.getByTestId("first-visit").textContent).toContain(
			"Anna Bakker invited you to run the rollout. Is that right?",
		);
		expect(screen.queryByText("Will run the rollout")).toBeNull();
	});

	it("posts the labels as they are once when confirmed, however often it is pressed", async () => {
		const { onAnswer, settle } = await show(["go_ahead", "rollout"]);
		const yes = screen.getByTestId("first-visit-yes");
		fireEvent.click(yes);
		fireEvent.click(yes);
		expect(onAnswer).toHaveBeenCalledTimes(1);
		expect(onAnswer).toHaveBeenCalledWith({
			labels: ["go_ahead", "rollout"],
			other: null,
		});
		settle();
		await vi.waitFor(() =>
			expect(screen.queryByTestId("first-visit-yes")).toBeNull(),
		);
	});

	it("posts the correction once, with the same choices as adding someone", async () => {
		const { onAnswer } = await show(["rollout"]);
		fireEvent.click(screen.getByTestId("first-visit-change"));
		const rollout = screen.getByTestId("label-rollout");
		expect(rollout.hasAttribute("data-selected")).toBe(true);
		expect(rollout.classList.contains("app-choice")).toBe(true);
		fireEvent.click(rollout);
		fireEvent.click(screen.getByTestId("label-privacy_ai"));
		const save = screen.getByTestId("first-visit-save");
		fireEvent.click(save);
		fireEvent.click(save);
		expect(onAnswer).toHaveBeenCalledTimes(1);
		expect(onAnswer).toHaveBeenCalledWith({
			labels: ["privacy_ai"],
			other: null,
		});
	});

	it("with no labels, asks what they do and shows the choices at once", async () => {
		const { onAnswer } = await show([]);
		expect(screen.getByTestId("first-visit").textContent).toContain(
			"Anna Bakker invited you. What do you do in this decision?",
		);
		expect(screen.queryByTestId("first-visit-yes")).toBeNull();
		fireEvent.click(screen.getByTestId("label-staff_stakeholders"));
		fireEvent.click(screen.getByTestId("first-visit-save"));
		expect(onAnswer).toHaveBeenCalledWith({
			labels: ["staff_stakeholders"],
			other: null,
		});
	});
});
