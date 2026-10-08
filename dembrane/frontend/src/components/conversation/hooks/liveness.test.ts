import { expect, it } from "vitest";
import { isLiveConversation } from "./index";

const cutoff = new Date("2026-10-07T12:00:00Z");
const recent = "2026-10-07T12:00:10Z";

it("a portal session with a recent chunk is live", () => {
	expect(
		isLiveConversation(
			{ last_chunk_at: recent, source: "PORTAL_AUDIO" },
			cutoff,
		),
	).toBe(true);
});

it("a finished session is not live, however recent its last chunk", () => {
	expect(
		isLiveConversation(
			{ is_finished: true, last_chunk_at: recent, source: "PORTAL_AUDIO" },
			cutoff,
		),
	).toBe(false);
});

it("an upload or an old chunk is not live", () => {
	expect(
		isLiveConversation(
			{ last_chunk_at: recent, source: "DASHBOARD_UPLOAD" },
			cutoff,
		),
	).toBe(false);
	expect(
		isLiveConversation(
			{ last_chunk_at: "2026-10-07T11:59:00Z", source: "PORTAL_TEXT" },
			cutoff,
		),
	).toBe(false);
});
