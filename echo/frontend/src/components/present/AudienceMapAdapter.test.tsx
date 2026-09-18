// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudienceMapAdapter } from "./AudienceMapAdapter";

const geometryDisposed = vi.hoisted(() => vi.fn());

vi.mock("@/components/map/data/adapter", () => ({
	buildMapGraph: () => ({
		budgetBounds: null,
		objectsById: new Map([
			[
				"revision-1",
				{
					detail: { statement: "A result", type: "argument" },
					type: "argument",
				},
			],
		]),
		overBudget: false,
		placedNodes: [
			{
				embedding: [0, 1],
				id: "revision-1",
				label: "A result",
				metadata: {
					objectId: "object-1",
					objectType: "argument",
					revisionId: "revision-1",
					sizeScale: 1,
				},
			},
		],
		relations: [],
		serverBudgets: { edgeLimit: 10, nodeLimit: 10 },
	}),
}));

vi.mock("@/components/map/layout/useMapGeometry", async () => {
	const React = await import("react");
	return {
		useMapGeometry: () => {
			React.useEffect(() => () => geometryDisposed(), []);
			return { mstEdges: [], neighbours: { fpLinks: [], nnLinks: [] } };
		},
	};
});

vi.mock("@/components/map/renderers/MstGraph", () => ({
	MstMap: () => <div>Audience tree renderer</div>,
}));

vi.mock("@/components/map/renderers/LocalMapGraph", () => ({
	LocalMap: () => <div>Audience local renderer</div>,
}));

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(() => {
	cleanup();
	geometryDisposed.mockClear();
	vi.unstubAllGlobals();
});

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			addEventListener: vi.fn(),
			matches: false,
			removeEventListener: vi.fn(),
		})),
	);
});

describe("AudienceMapAdapter", () => {
	const adapter = (active: boolean) => (
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<AudienceMapAdapter active={active} endpoint="/audience/map" />
			</MantineProvider>
		</I18nProvider>
	);

	it("does not request host capabilities while hidden and aborts an in-flight read", async () => {
		let signal: AbortSignal | undefined;
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			signal = init?.signal ?? undefined;
			return new Promise<Response>(() => {});
		});
		vi.stubGlobal("fetch", fetchMock);

		const view = render(adapter(false));
		expect(fetchMock).not.toHaveBeenCalled();

		view.rerender(adapter(true));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith(
			"/audience/map",
			expect.objectContaining({ credentials: "include" }),
		);

		view.rerender(adapter(false));
		expect(signal?.aborted).toBe(true);
	});

	it("disposes the geometry worker boundary when Map is hidden", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);
		const view = render(adapter(true));
		await screen.findByText("Audience tree renderer");
		expect(screen.getByText("Audience local renderer")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Display" }));
		fireEvent.click(await screen.findByRole("checkbox", { name: "Local map" }));
		expect(screen.queryByText("Audience local renderer")).toBeNull();
		expect(screen.getByText("Audience tree renderer")).toBeTruthy();

		view.rerender(adapter(false));
		expect(geometryDisposed).toHaveBeenCalledTimes(1);
	});

	it("shows sanitized existing assessments without calling host or model endpoints", async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						fact_checks: {
							"revision-1": {
								checkedAt: "2026-09-18T00:00:00Z",
								justification: "Supported by the prepared evidence.",
								status: "done",
								verdict: "true",
							},
						},
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(adapter(true));

		expect(await screen.findByText("A result")).toBeTruthy();
		expect(screen.getByText("Likely true")).toBeTruthy();
		expect(
			screen.getByText("Supported by the prepared evidence."),
		).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/audience/map");
	});
});
