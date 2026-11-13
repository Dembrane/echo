// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
	Providers,
	setUpDom,
} from "@/components/project/setup-suggestions/testing";
import { TEMPLATE_SUMMARIES } from "@/components/project/templates/projectTemplates.fixture";
import type { DigestResult } from "../digest";
import { DIGEST_RESULT_EN } from "../digest.fixture";
import { initialReview, type ReviewState, toCreateBody } from "../review";
import { DigestReview, type ReviewStepEvent } from "./DigestReview";

beforeAll(() => {
	setUpDom();
	globalThis.ResizeObserver ||= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as never;
});
afterEach(cleanup);

function Harness({
	result,
	onCreate,
	onStep,
}: {
	result: DigestResult;
	onCreate: (s: ReviewState) => void;
	onStep: (e: ReviewStepEvent) => void;
}) {
	const [value, setValue] = useState(initialReview(result, TEMPLATE_SUMMARIES));
	return (
		<DigestReview
			result={result}
			value={value}
			onChange={setValue}
			templates={TEMPLATE_SUMMARIES}
			onCreate={() => onCreate(value)}
			onStartOver={() => {}}
			onStep={onStep}
		/>
	);
}

const renderReview = (result: DigestResult = DIGEST_RESULT_EN) => {
	const onCreate = vi.fn();
	const onStep = vi.fn();
	render(
		<Providers>
			<Harness result={result} onCreate={onCreate} onStep={onStep} />
		</Providers>,
	);
	return { onCreate, onStep };
};

const step = () =>
	screen.getByTestId("project-digest-review").getAttribute("data-step");
const accept = () =>
	fireEvent.click(screen.getByTestId("project-digest-accept"));
const ORDER = [
	"name",
	"goal",
	"context",
	"key-terms",
	"template",
	"tags",
	"verify",
	"name-label",
	"explore",
	"host-steps",
	"summary",
];

it("shows one part per screen, in order, each with where it came from", () => {
	const { onStep } = renderReview();
	const seen: string[] = [];
	for (let i = 0; i < ORDER.length; i++) {
		seen.push(step() as string);
		const bar = screen.getByRole("progressbar");
		expect(bar.getAttribute("aria-valuenow")).toBe(String(i + 1));
		expect(bar.getAttribute("aria-valuemax")).toBe(String(ORDER.length));
		if (i < ORDER.length - 1) accept();
	}
	expect(seen).toEqual(ORDER);
	expect(onStep).toHaveBeenCalledWith({
		index: 4,
		step: "key_terms",
		total: 11,
		type: "viewed",
	});
	expect(onStep).toHaveBeenCalledWith({
		action: "accepted",
		step: "goal",
		type: "answered",
	});
});

it("says where a part came from and why the template, and the notes on the first screen", () => {
	renderReview();
	expect(screen.getByTestId("project-digest-note-personal")).toBeTruthy();
	expect(screen.getByTestId("project-digest-read-from")).toBeTruthy();
	accept();
	expect(screen.getByTestId("project-digest-provenance-goal").textContent).toBe(
		"From uitnodiging-bewonersavond.pdf",
	);
	accept();
	accept();
	accept();
	expect(
		screen.getByTestId("project-digest-template-reason").textContent,
	).toContain("Residents talk");
	expect(
		screen.getByTestId("template-illustration-resident_evening"),
	).toBeTruthy();
});

it("Enter accepts; in a text box it takes Ctrl or Cmd", () => {
	renderReview();
	fireEvent.keyDown(screen.getByRole("heading", { name: "Name" }), {
		key: "Enter",
	});
	expect(step()).toBe("goal");
	fireEvent.click(screen.getByTestId("project-digest-edit"));
	const goal = screen.getByTestId("project-digest-goal");
	expect(document.activeElement).toBe(goal);
	fireEvent.keyDown(goal, { key: "Enter" });
	expect(step()).toBe("goal");
	fireEvent.keyDown(goal, { ctrlKey: true, key: "Enter" });
	expect(step()).toBe("context");
});

it("edits in place, skips, goes back without losing edits; Create sends what is kept", () => {
	const { onCreate, onStep } = renderReview();
	accept();
	fireEvent.click(screen.getByTestId("project-digest-edit"));
	fireEvent.change(screen.getByTestId("project-digest-goal"), {
		target: { value: "New goal" },
	});
	accept();
	expect(onStep).toHaveBeenCalledWith({
		action: "edited",
		step: "goal",
		type: "answered",
	});
	fireEvent.click(screen.getByTestId("project-digest-back"));
	expect(step()).toBe("goal");
	expect(
		screen.getByTestId("project-digest-section-goal").textContent,
	).toContain("New goal");
	accept();
	accept();
	accept();
	fireEvent.click(screen.getByTestId("project-digest-runner-up-world_cafe"));
	accept();
	accept();
	accept();
	accept();
	expect(step()).toBe("explore");
	fireEvent.click(screen.getByTestId("project-digest-skip"));
	expect(onStep).toHaveBeenCalledWith({
		action: "skipped",
		step: "explore",
		type: "answered",
	});
	accept();
	expect(step()).toBe("summary");
	expect(
		screen.getByTestId("project-digest-summary-explore").textContent,
	).toContain("Skipped");
	expect(
		screen.getByTestId("project-digest-summary-template").textContent,
	).toContain("Rotating tables");
	fireEvent.click(screen.getByTestId("project-digest-create"));
	const body = toCreateBody(onCreate.mock.calls[0][0]);
	expect(body?.templateKey).toBe("world_cafe");
	expect(body?.digest.goal).toBe("New goal");
	expect(body?.digest.explore_prompt).toBeUndefined();
});

it("a skipped part comes back when accepted again, from the summary's Change", () => {
	const { onCreate } = renderReview();
	accept();
	fireEvent.click(screen.getByTestId("project-digest-skip"));
	fireEvent.click(screen.getByTestId("project-digest-accept-rest"));
	expect(step()).toBe("summary");
	fireEvent.click(screen.getByTestId("project-digest-summary-change-goal"));
	expect(step()).toBe("goal");
	expect(
		screen.getByTestId("project-digest-section-goal-skipped"),
	).toBeTruthy();
	accept();
	expect(step()).toBe("summary");
	fireEvent.click(screen.getByTestId("project-digest-create"));
	expect(toCreateBody(onCreate.mock.calls[0][0])?.digest.goal).toBeTruthy();
});

it("Accept the rest jumps to the summary and says how many parts it took", () => {
	const { onStep } = renderReview();
	fireEvent.click(screen.getByTestId("project-digest-accept-rest"));
	expect(step()).toBe("summary");
	expect(onStep).toHaveBeenCalledWith({
		remaining: 9,
		step: "name",
		type: "rest",
	});
	expect(screen.getAllByRole("button", { name: /^Change: / })).toHaveLength(10);
});

it("parts the digest left empty get no screen; without a name it asks for one", () => {
	renderReview({
		...DIGEST_RESULT_EN,
		explore_prompt: undefined,
		name: undefined,
		tags: undefined,
		verify_topics: undefined,
	});
	expect(step()).toBe("name");
	const name = screen.getByTestId("project-digest-name");
	expect(document.activeElement).toBe(name);
	expect(
		(screen.getByTestId("project-digest-accept") as HTMLButtonElement).disabled,
	).toBe(true);
	fireEvent.change(name, { target: { value: "Kanaalzone" } });
	fireEvent.click(screen.getByTestId("project-digest-accept-rest"));
	const lines = screen
		.getAllByRole("button", { name: /^Change: / })
		.map((b) => b.getAttribute("aria-label"));
	expect(lines).toEqual([
		"Change: Name",
		"Change: Goal",
		"Change: Project context",
		"Change: Key terms",
		"Change: Template",
		"Change: Name box",
		"Change: Host script additions",
	]);
});
