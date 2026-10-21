import { i18n } from "@lingui/core";
import { beforeAll, expect, it } from "vitest";
import {
	buildAttention,
	isActive,
	orgIsFree,
	totalRowHours,
} from "./OrganisationUsageRollup";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

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

const usageRow = (r: Record<string, unknown>) =>
	({
		allowance_account_id: null,
		approaching_cap: false,
		approaching_seat_cap: false,
		at_cap: false,
		audio_hours: 0,
		bills_separately: false,
		hours_counted: null,
		hours_included: 5,
		name: "W",
		seat_cap_hit: false,
		seat_count: 1,
		seats_included: null,
		tier: "free",
		...r,
	}) as unknown as Parameters<typeof buildAttention>[0][number];

it("raises one hours item for pooled workspaces at the cap", () => {
	const items = buildAttention([
		usageRow({ allowance_account_id: "a", at_cap: true, id: "w1" }),
		usageRow({ allowance_account_id: "a", at_cap: true, id: "w2" }),
		usageRow({
			allowance_account_id: "b",
			at_cap: true,
			id: "w3",
			name: "Solo",
		}),
	]);
	expect(items.map((i) => i.workspaceId)).toEqual(["w1", "w3"]);
	expect(items[0]?.message).toBe(
		"This organisation has used this month's free recording hours. Recording is paused until the month resets.",
	);
	expect(items[1]?.message).toContain("Solo has used");
});

it("raises one near-limit item for pooled workspaces", () => {
	const items = buildAttention([
		usageRow({
			allowance_account_id: "a",
			approaching_cap: true,
			hours_counted: 4.2,
			id: "w1",
		}),
		usageRow({
			allowance_account_id: "a",
			approaching_cap: true,
			hours_counted: 4.2,
			id: "w2",
		}),
	]);
	expect(items).toHaveLength(1);
});

it("drops 'paid' from the seat summary only when the org is free", () => {
	expect(
		orgIsFree([
			usageRow({}),
			usageRow({ bills_separately: true, tier: "changemaker" }),
		]),
	).toBe(true);
	expect(orgIsFree([usageRow({ tier: "changemaker" })])).toBe(false);
	expect(orgIsFree([])).toBe(false);
});
