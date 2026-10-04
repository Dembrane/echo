// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import type { Distillation } from "../hooks/useSelectionTitle";
import type { MapGraphNode } from "../types";
import { attributeShares, conversationShares } from "./ClusterSummary";
import { type HistoryItem, HistoryPanel } from "./HistoryPanel";

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

const Providers = ({ children }: { children: ReactNode }) => (
	<MantineProvider>
		<I18nProvider i18n={i18n}>{children}</I18nProvider>
	</MantineProvider>
);

const with_ = (
	node: MapGraphNode,
	metadata: Partial<MapGraphNode["metadata"]>,
): MapGraphNode => ({ ...node, metadata: { ...node.metadata, ...metadata } });

const nodes = createSyntheticMap({ count: 4 });
const nodesById = new Map(nodes.map((node) => [node.id, node] as const));

const cluster = (
	status: Distillation["status"],
	title?: string,
): HistoryItem => ({
	at: 1,
	distillation: {
		createdAt: "2026-10-04T00:00:00Z",
		id: `d-${status}`,
		key: status,
		nodeIds: nodes.slice(0, 3).map((node) => node.id),
		status,
		title,
	},
	id: `d-${status}`,
	kind: "cluster",
});

describe("HistoryPanel", () => {
	it("lists arguments and clusters, and brings one back when chosen", () => {
		const onSelect = vi.fn();
		const argument: HistoryItem = {
			at: 2,
			id: `argument-${nodes[3].id}`,
			kind: "argument",
			nodeId: nodes[3].id,
		};
		render(
			<Providers>
				<HistoryPanel
					items={[argument, cluster("done", "A shared worry")]}
					nodesById={nodesById}
					selectedId={argument.id}
					onSelect={onSelect}
					onRetry={vi.fn()}
				/>
			</Providers>,
		);
		expect(screen.getByText(nodes[3].label as string)).toBeTruthy();
		expect(screen.getByText("A shared worry")).toBeTruthy();
		expect(screen.getByText("3 arguments")).toBeTruthy();
		expect(
			screen.getByTestId("history-argument").getAttribute("aria-pressed"),
		).toBe("true");

		fireEvent.click(screen.getByText("A shared worry"));
		expect(onSelect).toHaveBeenCalledWith(
			expect.objectContaining({ id: "d-done" }),
		);
	});

	it("shows a pending cluster, and a failed one with its own Try again", () => {
		const onRetry = vi.fn();
		const onSelect = vi.fn();
		render(
			<Providers>
				<HistoryPanel
					items={[cluster("pending"), cluster("failed")]}
					nodesById={nodesById}
					selectedId={null}
					onSelect={onSelect}
					onRetry={onRetry}
				/>
			</Providers>,
		);
		expect(screen.getByText("Distilling core idea…")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(onRetry).toHaveBeenCalledWith("d-failed");
		expect(onSelect).not.toHaveBeenCalled();
	});
});

describe("cluster shares", () => {
	it("counts each conversation once per member, largest first", () => {
		const shares = conversationShares(
			[
				with_(nodes[0], { conversationSlots: [0] }),
				with_(nodes[1], { conversationSlots: [1, 1] }),
				with_(nodes[2], { conversationSlots: [1] }),
			],
			new Map([[1, "Ada"]]),
		);
		expect(shares.map(({ label, count }) => [label, count])).toEqual([
			["Ada", 3],
			["Conversation 1", 1],
		]);
	});

	it("groups valence, with the unassessed apart", () => {
		const shares = attributeShares(
			[
				with_(nodes[0], { valence: "positive" }),
				with_(nodes[1], { valence: "positive" }),
				with_(nodes[2], { valence: "negative" }),
				with_(nodes[3], { valence: undefined }),
			],
			"valence",
		);
		expect(shares.map((share) => share.count)).toEqual([2, 1, 1]);
		expect(new Set(shares.map((share) => share.key)).size).toBe(3);
	});
});
