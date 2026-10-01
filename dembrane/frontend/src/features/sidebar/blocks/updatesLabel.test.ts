import { describe, expect, it } from "vitest";
import { selectUpdatesLabel } from "./updatesLabel";

describe("selectUpdatesLabel", () => {
	it("is hidden when nothing is unread", () => {
		const state = selectUpdatesLabel({ count: 0, urgentTitle: null });
		expect(state.visible).toBe(false);
	});

	it("is hidden for a negative count", () => {
		expect(selectUpdatesLabel({ count: -1, urgentTitle: null }).visible).toBe(
			false,
		);
	});

	it("shows no badge for a single non-urgent update", () => {
		const state = selectUpdatesLabel({ count: 1, urgentTitle: null });
		expect(state).toEqual({
			badge: undefined,
			count: 1,
			title: null,
			urgent: false,
			visible: true,
		});
	});

	it("shows a count badge for several non-urgent updates", () => {
		const state = selectUpdatesLabel({ count: 3, urgentTitle: null });
		expect(state.badge).toBe(3);
		expect(state.urgent).toBe(false);
		expect(state.title).toBeNull();
	});

	it("shows the urgent title and the batch count together", () => {
		const state = selectUpdatesLabel({
			count: 3,
			urgentTitle: "Scheduled maintenance on Sunday",
		});
		expect(state).toEqual({
			badge: 3,
			count: 3,
			title: "Scheduled maintenance on Sunday",
			urgent: true,
			visible: true,
		});
	});

	it("shows an urgent title with no badge when it is the only update", () => {
		const state = selectUpdatesLabel({ count: 1, urgentTitle: "Outage" });
		expect(state.badge).toBeUndefined();
		expect(state.urgent).toBe(true);
		expect(state.title).toBe("Outage");
	});

	it("falls back to the static label when the urgent title is empty", () => {
		// An empty translation title would otherwise render a blank row.
		for (const urgentTitle of ["", "   ", null, undefined]) {
			const state = selectUpdatesLabel({ count: 2, urgentTitle });
			expect(state.urgent).toBe(false);
			expect(state.title).toBeNull();
			expect(state.badge).toBe(2);
		}
	});

	it("trims the urgent title", () => {
		expect(
			selectUpdatesLabel({ count: 1, urgentTitle: "  Outage  " }).title,
		).toBe("Outage");
	});
});
