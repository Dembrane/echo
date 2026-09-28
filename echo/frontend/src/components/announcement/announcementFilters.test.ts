import { describe, expect, it } from "vitest";
import { isReadByMe, isUnreadByMe } from "./announcementFilters";

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
