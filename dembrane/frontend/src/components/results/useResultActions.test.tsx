// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/bff";
import { type HoldBackAdapter, useResultActions } from "./useResultActions";

vi.mock("@/lib/bff", () => ({ bff: { get: vi.fn(), post: vi.fn() } }));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const setUp = (holdBack?: HoldBackAdapter) =>
	renderHook(() => useResultActions({ holdBack, projectId: "project-1" }), {
		wrapper,
	}).result;

beforeEach(() => {
	vi.mocked(bff.post).mockResolvedValue({
		revision: { revisionId: "rev-3", type: "popcorn" },
	});
	window.localStorage.clear();
});

afterEach(() => vi.clearAllMocks());

describe("what a host does to a finding", () => {
	it("sends the kind with a patch of the one field that changed", async () => {
		const actions = setUp();
		await actions.current.editWords({
			changeKind: "clarity",
			expectedRevisionId: "rev-2",
			field: "phrase",
			objectId: "obj-1",
			words: "New words",
		});
		expect(vi.mocked(bff.post).mock.calls[0][0]).toBe(
			"/analysis/projects/project-1/objects/obj-1/revisions",
		);
		expect(vi.mocked(bff.post).mock.calls[0][1]).toEqual({
			change_kind: "clarity",
			expected_revision_id: "rev-2",
			// The one allowlisted field, and nothing else: no evidence, no quotes.
			patch: { phrase: "New words" },
			reason: undefined,
		});
	});

	it("undoes as a rollback against the revision the edit produced", async () => {
		const actions = setUp();
		await actions.current.undoWords({
			expectedRevisionId: "rev-3",
			objectId: "obj-1",
			toRevisionId: "rev-2",
		});
		expect(vi.mocked(bff.post).mock.calls[0][0]).toContain("/rollback");
		expect(vi.mocked(bff.post).mock.calls[0][1]).toEqual({
			change_kind: "rollback",
			expected_revision_id: "rev-3",
			to_revision_id: "rev-2",
		});
	});

	it("passes the reason to the adapter and remembers it for next time", () => {
		const setHeld = vi.fn();
		const adapter: HoldBackAdapter = { isHeld: () => false, setHeld };
		setUp(adapter).current.holdBack?.("obj-1", "off topic for this room");
		expect(setHeld).toHaveBeenCalledWith(
			"obj-1",
			true,
			"off topic for this room",
		);
		// The next prompt leads with what this host said last.
		expect(setUp(adapter).current.heldBackReasons[0]).toBe(
			"off topic for this room",
		);
	});

	it("keeps the reason for the row to say, and lets it go on the way back", () => {
		const adapter: HoldBackAdapter = { isHeld: () => false, setHeld: vi.fn() };
		const actions = setUp(adapter);
		actions.current.holdBack?.("obj-1", "off topic for this room");
		expect(actions.current.heldReason("obj-1")).toBe("off topic for this room");
		actions.current.showAgain?.("obj-1", "");
		expect(actions.current.heldReason("obj-1")).toBeUndefined();
	});

	it("holds nothing back where there is no presentation behind the list", () => {
		const actions = setUp();
		expect(actions.current.holdBack).toBeNull();
		expect(actions.current.isHeld("obj-1")).toBe(false);
	});
});
