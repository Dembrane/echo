import { describe, expect, it } from "vitest";
import {
	isReadByMe,
	isUnreadByMe,
	notExpiredFilter,
} from "./announcementFilters";

const NOW = "2026-08-12T00:00:00.000Z";

describe("notExpiredFilter", () => {
	it("accepts a future expiry or no expiry at all", () => {
		expect(notExpiredFilter(NOW)).toEqual({
			_or: [{ expires_at: { _gte: NOW } }, { expires_at: { _null: true } }],
		});
	});

	it("defaults to the current time when none is given", () => {
		const gte = notExpiredFilter()._or[0].expires_at._gte;
		expect(Number.isNaN(Date.parse(gte))).toBe(false);
	});
});

describe("isReadByMe / isUnreadByMe", () => {
	it("treats no activity row as unread", () => {
		expect(isUnreadByMe([])).toBe(true);
		expect(isUnreadByMe(null)).toBe(true);
		expect(isUnreadByMe(undefined)).toBe(true);
	});

	it("treats a read:true row as read", () => {
		expect(isReadByMe([{ read: true }])).toBe(true);
		expect(isUnreadByMe([{ read: true }])).toBe(false);
	});

	// The bug this whole shared definition exists to prevent.
	it("treats a read:false row as unread", () => {
		expect(isUnreadByMe([{ read: false }])).toBe(true);
	});

	// Older data can carry both states, from when marking read created a row.
	it("treats a mixed pair as read", () => {
		expect(isReadByMe([{ read: false }, { read: true }])).toBe(true);
		expect(isReadByMe([{ read: true }, { read: false }])).toBe(true);
	});

	it("does not treat null or missing read as read", () => {
		expect(isUnreadByMe([{ read: null }])).toBe(true);
		expect(isUnreadByMe([{}])).toBe(true);
	});
});
