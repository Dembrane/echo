// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildMapGraph } from "../data/adapter";
import { FIXTURE_BUDGETS } from "../data/fixture";
import { relatedObjects } from "../data/relations";
import { createSyntheticPayload } from "../fixtures/syntheticMap";
import type { MapGraphNode, ObjectType } from "../types";
import { NodeDetailCard, type NodeInspection } from "./NodeDetailCard";
import { SpotlightPanel } from "./SpotlightPanel";

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

const { payload } = createSyntheticPayload({
	budgets: FIXTURE_BUDGETS,
	counts: { argument: 6, popcorn: 1, stakeholder: 1, tension: 1 },
});
const graph = buildMapGraph(payload);
const nodesById = new Map(graph.allNodes.map((node) => [node.id, node]));

const Providers = ({ children }: { children: ReactNode }) => (
	<MantineProvider>
		<I18nProvider i18n={i18n}>
			<MemoryRouter>{children}</MemoryRouter>
		</I18nProvider>
	</MantineProvider>
);

const inspect = (
	nodeId: string,
	visible: ObjectType[],
): { node: MapGraphNode; inspection: NodeInspection } => {
	const visibleIds = new Set(
		graph.allNodes
			.filter((item) => visible.includes(item.metadata.objectType))
			.map((item) => item.id),
	);
	return {
		inspection: {
			canRevealRelatedTypes: true,
			evidenceFor: (id) => graph.evidenceById.get(id) ?? [],
			object: graph.objectsById.get(nodeId) ?? null,
			onReveal: vi.fn(),
			onSelect: vi.fn(),
			related: relatedObjects(nodeId, graph, nodesById, visibleIds),
		},
		node: nodesById.get(nodeId) as MapGraphNode,
	};
};

const renderCard = (nodeId: string, visible: ObjectType[]) => {
	const { node, inspection } = inspect(nodeId, visible);
	render(
		<Providers>
			<NodeDetailCard
				node={node}
				evidence={graph.evidenceById.get(nodeId) ?? []}
				inspection={inspection}
			/>
		</Providers>,
	);
	return inspection;
};

describe("inspector per type", () => {
	it("shows a tension's poles, narrative, question and support per pole", () => {
		const inspection = renderCard("rev-tension-0", ["tension"]);
		// The poles, the knot and the question are on the stage card now, in the
		// tension's own shape rather than under labels.
		expect(screen.getByTestId("result-stage")).toBeTruthy();
		expect(screen.getByText("Synthetic pole A 0")).toBeTruthy();
		expect(screen.getByText("Synthetic pole B 0")).toBeTruthy();
		expect(
			screen.getByText("Two groups read synthetic topic 0 in opposite ways."),
		).toBeTruthy();
		expect(screen.getByText(/To resolve:/)).toBeTruthy();
		expect(screen.getByText("Supporting pole A")).toBeTruthy();
		expect(screen.getByText("Supporting pole B")).toBeTruthy();
		// Supporting arguments carry their evidence.
		expect(
			screen.getAllByText(/as a participant put it/).length,
		).toBeGreaterThan(2);

		// Three supporting arguments and the affected stakeholder are hidden by
		// the filter: listed, with a reveal action.
		expect(screen.getAllByText("Hidden by the Objects filter")).toHaveLength(4);
		expect(
			screen.getAllByRole("button", { name: "Show Stakeholders" }),
		).toHaveLength(1);
		fireEvent.click(
			screen.getAllByRole("button", { name: "Show Arguments" })[0],
		);
		expect(inspection.onReveal).toHaveBeenCalledWith("argument");
		expect(inspection.onSelect).not.toHaveBeenCalled();
	});

	it("selects a visible supporting argument without touching the filter", () => {
		const inspection = renderCard("rev-tension-0", [
			"tension",
			"argument",
			"stakeholder",
		]);
		expect(screen.queryByText("Hidden by the Objects filter")).toBeNull();
		const supporter = graph.relations.find(
			(relation) =>
				relation.target === "rev-tension-0" &&
				relation.type === "supports_pole_b",
		);
		const label = nodesById.get(supporter?.source ?? "")?.label ?? "";
		fireEvent.click(screen.getByRole("button", { name: label }));
		expect(inspection.onSelect).toHaveBeenCalledWith(supporter?.source);
		expect(inspection.onReveal).not.toHaveBeenCalled();
	});

	it("shows a stakeholder's role, stake, evidence rung and connections", () => {
		renderCard("rev-stakeholder-0", ["stakeholder"]);
		// Name, role and stake read as the stage card shows them.
		expect(screen.getByTestId("result-stage")).toBeTruthy();
		expect(screen.getByText("Synthetic role 0")).toBeTruthy();
		expect(screen.getByText("Synthetic stake 0")).toBeTruthy();
		expect(screen.getByText("Voiced in a conversation")).toBeTruthy();
		expect(screen.getByText("Evidenced connections")).toBeTruthy();
		expect(
			screen.getByText("Holds position · From the transcript"),
		).toBeTruthy();
		expect(screen.getByText("Affected by · Inferred")).toBeTruthy();
	});

	it("shows popcorn's phrase with its source evidence and provenance", () => {
		renderCard("rev-popcorn-0", ["popcorn"]);
		expect(screen.getByText("Synthetic phrase 0")).toBeTruthy();
		expect(screen.getByText("Source evidence")).toBeTruthy();
		expect(
			screen.getByText("Synthetic phrase 0, as a participant put it"),
		).toBeTruthy();
		expect(screen.getByText("Source: Generated")).toBeTruthy();
		expect(screen.getByText("Recipe: popcorn · fixture-1")).toBeTruthy();
		expect(
			screen.getByText("Revision history is not available yet."),
		).toBeTruthy();
	});

	it("explains a merge from pinned source statements and evidence", () => {
		const base = nodesById.get("rev-argument-0") as MapGraphNode;
		const node: MapGraphNode = {
			...base,
			label: "Combined statement",
			metadata: { ...base.metadata, consolidation: { memberCount: 2 } },
		};
		const object = graph.objectsById.get(base.id);
		expect(object).toBeTruthy();
		const inspection: NodeInspection = {
			evidenceFor: () => [],
			object: object
				? {
						...object,
						detail: {
							consolidation: {
								legacy: false,
								memberCount: 2,
								members: [
									{
										evidence: [
											{
												conversationId: "conversation-1",
												label: "Conversation one",
												quotes: ["Pinned source quote"],
												slot: 0,
											},
										],
										objectId: "source-1",
										revisionId: "source-rev-1",
										statement: "First source statement",
									},
									{
										evidence: [],
										objectId: "source-2",
										revisionId: "source-rev-2",
										statement: "Second source statement",
									},
								],
							},
							statement: "Combined statement",
							type: "deduplicated_argument",
						},
					}
				: null,
			related: [],
		};
		render(
			<Providers>
				<NodeDetailCard node={node} evidence={[]} inspection={inspection} />
			</Providers>,
		);

		expect(screen.getByText("Argument")).toBeTruthy();
		expect(screen.queryByText("Deduplicated argument")).toBeNull();
		expect(screen.getByText("Combined from 2 arguments")).toBeTruthy();
		expect(screen.getByText(/First source statement/)).toBeTruthy();
		expect(screen.getByText(/Second source statement/)).toBeTruthy();
		expect(screen.getByText("Pinned source quote")).toBeTruthy();
	});

	it("explains when an older merge's source statements are unavailable", () => {
		const base = nodesById.get("rev-argument-0") as MapGraphNode;
		const object = graph.objectsById.get(base.id);
		render(
			<Providers>
				<NodeDetailCard
					node={{
						...base,
						metadata: { ...base.metadata, consolidation: { memberCount: 3 } },
					}}
					evidence={[]}
					inspection={{
						evidenceFor: () => [],
						object: object
							? {
									...object,
									detail: {
										consolidation: {
											legacy: true,
											memberCount: 3,
											members: [],
										},
										statement: base.label,
										type: "argument",
									},
								}
							: null,
						related: [],
					}}
				/>
			</Providers>,
		);
		expect(screen.getByText("Combined from 3 arguments")).toBeTruthy();
		expect(
			screen.getByText(
				"The original statements are unavailable for this older result.",
			),
		).toBeTruthy();
	});

	it("shows the room's quotes under their conversation, in its colour", () => {
		const node = nodesById.get("rev-argument-0") as MapGraphNode;
		render(
			<Providers>
				<NodeDetailCard
					node={node}
					evidence={[
						{
							conversationId: "slot:1",
							label: "Conversation 2",
							quotes: ["The bins are always full."],
							slot: 1,
						},
					]}
				/>
			</Providers>,
		);
		expect(screen.getByText("Conversation 2")).toBeTruthy();
		expect(screen.getByText("The bins are always full.")).toBeTruthy();
		// The dot the legend gives that conversation, so the quote is read in
		// the colour it was spoken in.
		expect(screen.getByTestId("quote-group-slot-1")).toBeTruthy();
		// The room's surface links nowhere: no conversation to open.
		expect(screen.queryByRole("link")).toBeNull();
	});
});

describe("Spotlight fact-check controls", () => {
	const argumentNode = nodesById.get("rev-argument-0") as MapGraphNode;
	const withMetadata = (
		base: MapGraphNode,
		metadata: Partial<MapGraphNode["metadata"]>,
	): MapGraphNode => ({ ...base, metadata: { ...base.metadata, ...metadata } });

	const renderSpotlight = (node: MapGraphNode) =>
		render(
			<Providers>
				<SpotlightPanel
					node={node}
					evidence={[]}
					factCheck={
						node.metadata.factCheckEligible ? { status: "idle" } : undefined
					}
					colorBy="factCheck"
					onColorByChange={vi.fn()}
					canFactCheck
					onFactCheck={vi.fn()}
					onCancelFactCheck={vi.fn()}
				/>
			</Providers>,
		);

	it("offers a check for an eligible claim", () => {
		renderSpotlight(
			withMetadata(argumentNode, {
				epistemicKind: "claim",
				factCheckEligible: true,
			}),
		);
		expect(
			screen.getByRole("button", { name: "Fact check this claim" }),
		).toBeTruthy();
	});

	it("offers none for a claim without the capability", () => {
		renderSpotlight(
			withMetadata(argumentNode, {
				epistemicKind: "claim",
				factCheckEligible: false,
			}),
		);
		expect(
			screen.queryByRole("button", { name: "Fact check this claim" }),
		).toBeNull();
	});

	it("says factual status does not apply to a tension", () => {
		renderSpotlight(nodesById.get("rev-tension-0") as MapGraphNode);
		expect(
			screen.getByText("Factual status does not apply to this object."),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Fact check this claim" }),
		).toBeNull();
	});
});
