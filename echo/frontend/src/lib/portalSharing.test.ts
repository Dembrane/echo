import { describe, expect, it } from "vitest";
import { buildPortalSessionSharingLink } from "./portalSharing";

describe("buildPortalSessionSharingLink", () => {
	it("keeps reusable portal configuration on a fresh start link", () => {
		const link = buildPortalSessionSharingLink(
			"https://portal.dembrane.com/en-US/project-1/start?theme=DM+Sans&utm_source=portal",
			new URLSearchParams(
				"skipOnboarding=1&tags=Table+1&tag_id_list=tag-1&mode=text&theme=Space+Grotesk",
			),
		);
		const url = new URL(link);

		expect(url.pathname).toBe("/en-US/project-1/start");
		expect(url.searchParams.get("skipOnboarding")).toBe("1");
		expect(url.searchParams.get("tags")).toBe("Table 1");
		expect(url.searchParams.get("tag_id_list")).toBe("tag-1");
		expect(url.searchParams.get("mode")).toBe("text");
		expect(url.searchParams.get("theme")).toBe("Space Grotesk");
		expect(url.searchParams.get("utm_source")).toBe("portal");
	});

	it("does not carry participant data or temporary route state", () => {
		const link = buildPortalSessionSharingLink(
			"https://portal.dembrane.com/en-US/project-1/start?utm_source=portal",
			new URLSearchParams(
				"participant_name=Alice&name=Alice&title=Table+1&participant_email=alice%40example.com&email=alice%40example.com&general_feedback=Private+note&feedback=Private+note&instructions=true&utm_source=qr_scan&skipOnboarding=1",
			),
		);
		const url = new URL(link);

		expect(url.searchParams.get("skipOnboarding")).toBe("1");
		expect(url.searchParams.get("utm_source")).toBe("portal");
		expect(url.searchParams.has("participant_name")).toBe(false);
		expect(url.searchParams.has("name")).toBe(false);
		expect(url.searchParams.has("title")).toBe(false);
		expect(url.searchParams.has("participant_email")).toBe(false);
		expect(url.searchParams.has("email")).toBe(false);
		expect(url.searchParams.has("general_feedback")).toBe(false);
		expect(url.searchParams.has("feedback")).toBe(false);
		expect(url.searchParams.has("instructions")).toBe(false);
	});
});
