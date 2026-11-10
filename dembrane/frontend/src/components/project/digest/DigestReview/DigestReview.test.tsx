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
import { DigestReview } from "./DigestReview";

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
}: {
	result: DigestResult;
	onCreate: (s: ReviewState) => void;
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
		/>
	);
}

const renderReview = (result: DigestResult = DIGEST_RESULT_EN) => {
	const onCreate = vi.fn();
	render(
		<Providers>
			<Harness result={result} onCreate={onCreate} />
		</Providers>,
	);
	return onCreate;
};

it("shows every part with where it came from", () => {
	renderReview();
	for (const id of [
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
	])
		expect(screen.getByTestId(`project-digest-section-${id}`)).toBeTruthy();
	expect(screen.getByTestId("project-digest-provenance-goal").textContent).toBe(
		"From uitnodiging-bewonersavond.pdf",
	);
	expect(
		screen.getByTestId("project-digest-template-reason").textContent,
	).toContain("Residents talk");
	expect(screen.getByTestId("project-digest-note-personal")).toBeTruthy();
});

it("edits in place, switches off and changes template; Create sends what is on", () => {
	const onCreate = renderReview();
	fireEvent.change(screen.getByTestId("project-digest-goal"), {
		target: { value: "New goal" },
	});
	fireEvent.click(
		screen.getByRole("switch", { name: "Use this Explore question" }),
	);
	fireEvent.click(screen.getByTestId("project-digest-runner-up-world_cafe"));
	fireEvent.click(screen.getByTestId("project-digest-create"));
	const body = toCreateBody(onCreate.mock.calls[0][0]);
	expect(body?.templateKey).toBe("world_cafe");
	expect(body?.digest.goal).toBe("New goal");
	expect(body?.digest.explore_prompt).toBeUndefined();
});

it("parts the digest left empty are not shown; without a name Create waits", () => {
	renderReview({
		...DIGEST_RESULT_EN,
		explore_prompt: undefined,
		name: undefined,
		tags: undefined,
	});
	expect(screen.queryByTestId("project-digest-section-explore")).toBeNull();
	expect(screen.queryByTestId("project-digest-section-tags")).toBeNull();
	expect(
		(screen.getByTestId("project-digest-create") as HTMLButtonElement).disabled,
	).toBe(true);
});
