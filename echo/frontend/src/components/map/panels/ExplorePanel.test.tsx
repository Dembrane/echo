// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Distillation } from "../hooks/useSelectionTitle";
import type { MapGraphNode } from "../types";
import { ExplorePanel } from "./ExplorePanel";

i18n.load("en-US", {});
i18n.activate("en-US");

beforeAll(() => {
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

const node = (id: string, label: string): MapGraphNode => ({
	embedding: [1, 0],
	id,
	label,
	metadata: {
		conversationIds: [],
		createdAt: null,
		kind: "argument",
		quotes: [],
		valence: "neutral",
	},
});

const renderPanel = (props: Partial<Parameters<typeof ExplorePanel>[0]> = {}) =>
	render(
		<MantineProvider>
			<I18nProvider i18n={i18n}>
				<ExplorePanel
					isProcessing={false}
					error={null}
					onRetry={() => {}}
					history={[]}
					nodesById={new Map()}
					selectedDistillationId={null}
					onSelectDistillation={() => {}}
					{...props}
				/>
			</I18nProvider>
		</MantineProvider>,
	);

describe("ExplorePanel", () => {
	it("lists only the contributing nodes that still exist", () => {
		const history: Distillation[] = [
			{
				createdAt: "2026-09-15T10:00:00Z",
				id: "d1",
				key: "r::a,b,gone",
				nodeIds: ["a", "gone", "b"],
				title: "A shared idea",
			},
		];
		renderPanel({
			history,
			nodesById: new Map([
				["a", node("a", "First node")],
				["b", node("b", "Second node")],
			]),
			selectedDistillationId: "d1",
		});

		const toggle = screen.getByRole("button", {
			name: /Contributing nodes \(2\)/,
		});
		fireEvent.click(toggle);

		expect(screen.getAllByRole("listitem")).toHaveLength(2);
		expect(screen.getByText(/First node/)).toBeTruthy();
		expect(screen.getByText(/Second node/)).toBeTruthy();
	});

	it("shows a retryable failure and the too-large message", () => {
		const onRetry = vi.fn();
		const { unmount } = renderPanel({
			error: { kind: "failed", nodeIds: ["a", "b", "c"] },
			onRetry,
		});
		expect(screen.getByText("The title could not be generated.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
		unmount();

		renderPanel({ error: { kind: "too-large", nodeIds: ["a", "b", "c"] } });
		expect(
			screen.getByText("This selection is too large to title."),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	});

	it("shows the pending state", () => {
		renderPanel({ isProcessing: true });
		expect(screen.getByText("Distilling core idea...")).toBeTruthy();
	});
});
