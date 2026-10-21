import { expect, it } from "vitest";
import { isActive, totalRowHours } from "./OrganisationUsageRollup";

it("totals the hours the rows show, counting a pooled free ledger once", () => {
	expect(
		totalRowHours([
			{ allowance_account_id: "a", audio_hours: 0, hours_counted: 5 },
			{ allowance_account_id: "a", audio_hours: 1, hours_counted: 5 },
			{ allowance_account_id: "b", audio_hours: 0, hours_counted: 2 },
			{ allowance_account_id: null, audio_hours: 3, hours_counted: 3 },
			{ audio_hours: 1.5, hours_counted: null },
		]),
	).toBe(11.5);
});

it("keeps paid rows on calendar hours", () => {
	expect(
		totalRowHours([
			{ audio_hours: 4, hours_counted: 4 },
			{ audio_hours: 2, hours_counted: null },
		]),
	).toBe(6);
});

it("counts a free workspace with ledger hours as active", () => {
	const row = (r: Record<string, unknown>) =>
		r as unknown as Parameters<typeof isActive>[0];
	expect(
		isActive(row({ audio_hours: 0, hours_counted: 2, seat_count: 0 })),
	).toBe(true);
	expect(
		isActive(row({ audio_hours: 0, hours_counted: null, seat_count: 0 })),
	).toBe(false);
});
