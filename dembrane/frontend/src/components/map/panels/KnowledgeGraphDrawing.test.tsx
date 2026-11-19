// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";
import type { MapGraphNode } from "../types";
import {
	GRAPH_HEIGHT,
	KnowledgeGraph,
	type KnowledgeGraphData,
	layoutKnowledgeGraph,
} from "./KnowledgeGraph";

// The drawing lays each new centre out from where the last layout put
// things, so a travel moves the drawing on rather than reshuffling it.
beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
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
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

// jsdom measures no width, so the drawing uses its fallback.
const WIDTH = 400;
const argument = (id: string) =>
	({ focus: false, id, kind: "argument", nodeId: id }) as const;
const graph: KnowledgeGraphData = {
	links: [
		{ kind: "tree", source: "a", target: "b" },
		{ kind: "tree", source: "b", target: "c" },
		{ kind: "tree", source: "c", target: "d" },
	],
	nodes: ["a", "b", "c", "d"].map(argument),
};
const nodesById = new Map<string, MapGraphNode>();

const tree = (centre: string | null, marked: string | null = null) => (
	<I18nProvider i18n={i18n}>
		<MantineProvider env="test">
			<KnowledgeGraph
				graph={graph}
				nodesById={nodesById}
				colorBy="none"
				darkMode={false}
				marked={marked}
				centre={centre}
				onPick={() => {}}
			/>
		</MantineProvider>
	</I18nProvider>
);
const drawn = () =>
	Object.fromEntries(
		screen
			.getAllByRole("button")
			.filter((el) => el.dataset.nodeId)
			.map((el) => {
				const dot = el.querySelector("circle") as SVGCircleElement;
				return [
					el.dataset.nodeId,
					[Number(dot.getAttribute("cx")), Number(dot.getAttribute("cy"))],
				];
			}),
	);
const asDrawn = (layout: Map<string, { x: number; y: number }>) =>
	Object.fromEntries([...layout].map(([id, p]) => [id, [p.x, p.y]]));

it("keeps its layout through a render that changes nothing it lays out", () => {
	const view = render(tree(null));
	const before = drawn();
	view.rerender(tree(null, "a"));
	expect(drawn()).toEqual(before);
});

it("lays a new centre out from the last layout", () => {
	const view = render(tree(null));
	view.rerender(tree("b"));
	const first = layoutKnowledgeGraph(graph, WIDTH, GRAPH_HEIGHT);
	const seeded = layoutKnowledgeGraph(graph, WIDTH, GRAPH_HEIGHT, {
		centre: "b",
		seed: first,
	});
	expect(drawn()).toEqual(asDrawn(seeded));
	expect(drawn().b).toEqual([WIDTH / 2, GRAPH_HEIGHT / 2]);
});
