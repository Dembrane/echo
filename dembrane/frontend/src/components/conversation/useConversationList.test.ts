import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it, vi } from "vitest";

// SORT_OPTIONS translates at import time.
await vi.hoisted(async () => {
	const { i18n } = await import("@lingui/core");
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

vi.mock("@/components/project/hooks", () => ({ useProjectById: vi.fn() }));
vi.mock("./hooks", () => ({
	useConversationsCountByProjectId: vi.fn(),
	useInfiniteConversationsByProjectId: vi.fn(),
}));

import { formatStartedAt, formatStartedAtFull } from "./useConversationList";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-15T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

beforeAll(() => {
	vi.useFakeTimers({ now, toFake: ["Date"] });
});

describe("formatStartedAt", () => {
	it("stays relative inside the last week", () => {
		expect(formatStartedAt(ago(3 * DAY), now)).toBe("3 days ago");
		expect(formatStartedAt(ago(7 * DAY - 60_000), now)).toBe("7 days ago");
	});

	it("shows the date once it is a week or older", () => {
		expect(formatStartedAt(ago(22 * DAY), now)).toBe("Sep 23, 2026");
		expect(formatStartedAt(ago(7 * DAY), now)).toBe("Oct 8, 2026");
	});

	it("follows the active locale", () => {
		i18n.load("nl-NL", {});
		i18n.activate("nl-NL");
		expect(formatStartedAt(ago(22 * DAY), now)).toBe("23 sep 2026");
		i18n.activate("en-US");
	});

	it("reads a missing or malformed start time as unknown", () => {
		expect(formatStartedAt(null, now)).toBe("Unknown date");
		expect(formatStartedAt("not a date", now)).toBe("Unknown date");
		expect(formatStartedAtFull(null)).toBeNull();
		expect(formatStartedAtFull("not a date")).toBeNull();
	});

	it("gives the full date and time for the hover", () => {
		expect(formatStartedAtFull(ago(22 * DAY))).toMatch(
			/^September 23, 2026 at \d{1,2}:\d{2}\s?(AM|PM)$/,
		);
	});
});
