// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	Providers,
	setUpDom,
} from "@/components/project/setup-suggestions/testing";
import { TEMPLATE_SUMMARIES } from "@/components/project/templates/projectTemplates.fixture";
import { DigestConnected } from "./DigestConnected";
import { DIGEST_RESULT_EN } from "./digest.fixture";

const events = vi.hoisted(() => [] as [string, Record<string, unknown>][]);
vi.mock("@/lib/analytics/events", () => ({
	track: (name: string, props: Record<string, unknown>) =>
		events.push([name, props]),
}));
vi.mock("@/config", () => ({ API_BASE_URL: "/api" }));

beforeAll(() => {
	setUpDom();
	globalThis.ResizeObserver ||= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as never;
	window.scrollTo = () => {};
});
beforeEach(() => {
	events.length = 0;
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const AGENDA = "Agenda bewonersavond Kanaalzone-Oost\nRonde 1: Wat gaat goed?";

const renderConnected = () => {
	const props = {
		creating: false,
		onActiveChange: vi.fn(),
		onCreate: vi.fn(async () => true),
		onFallback: vi.fn(),
	};
	const view = render(
		<Providers>
			<DigestConnected
				workspaceId="w1"
				language="en"
				templates={TEMPLATE_SUMMARIES}
				pageDrop={false}
				{...props}
			/>
		</Providers>,
	);
	return { ...view, ...props };
};

const drop = async (container: HTMLElement) => {
	const input = (await waitFor(() => {
		const el = container.querySelector("input[type=file]");
		if (!el) throw new Error("not yet");
		return el;
	})) as HTMLInputElement;
	fireEvent.change(input, {
		target: {
			files: [new File([AGENDA], "agenda.txt", { type: "text/plain" })],
		},
	});
};

it("reads the file here, sends only its text, and shows the review", async () => {
	const fetch = vi.fn(
		async () => new Response(JSON.stringify(DIGEST_RESULT_EN)),
	);
	vi.stubGlobal("fetch", fetch);
	const { container, onActiveChange, onCreate } = renderConnected();
	await drop(container);
	await screen.findByTestId("project-digest-review");
	expect(onActiveChange).toHaveBeenLastCalledWith(true);
	const body = JSON.parse(
		String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body),
	);
	expect(body.sources).toEqual([
		{ kind: "file", name: "agenda.txt", text: AGENDA },
	]);
	fireEvent.click(screen.getByTestId("project-digest-create"));
	await waitFor(() => expect(onCreate).toHaveBeenCalled());
	await waitFor(() =>
		expect(events.map((e) => e[0])).toContain("project_digest_applied"),
	);
	expect(events.map((e) => e[0])).toEqual([
		"project_digest_started",
		"project_digest_ready",
		"project_digest_applied",
	]);
	// Never names, text or terms in an event.
	expect(JSON.stringify(events)).not.toMatch(/agenda|Kanaalzone|Thuisbasis/i);
});

it("falls back to the picker with the text for the context when the digest fails", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 503 })),
	);
	const { container, onFallback, onActiveChange } = renderConnected();
	await drop(container);
	await screen.findByTestId("project-digest-fallback");
	expect(onFallback).toHaveBeenCalledWith({
		cause: "unavailable",
		context: AGENDA,
		cut: false,
	});
	expect(onActiveChange).toHaveBeenLastCalledWith(false);
	expect(events.at(-1)).toEqual([
		"project_digest_failed",
		{ cause: "unavailable", surface: "picker" },
	]);
});
