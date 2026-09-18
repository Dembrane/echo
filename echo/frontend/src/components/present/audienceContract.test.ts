import { describe, expect, it, vi } from "vitest";
import {
	audienceUrls,
	deckBlockCommand,
	deckOpeningCommand,
	deckVisibilityCommand,
	isDeckOpeningEvent,
	isDeckReadyEvent,
	postDeckMessage,
} from "./audienceContract";

describe("audience presentation contract", () => {
	it("addresses opening screens and validates their deck state", () => {
		expect(deckOpeningCommand("presentation-1", "data")).toEqual({
			command: "opening",
			presentationId: "presentation-1",
			screen: "data",
			source: "dembrane-present-shell",
			version: 1,
		});
		const source = {} as MessageEventSource;
		expect(
			isDeckOpeningEvent(
				{
					data: {
						open: false,
						presentationId: "presentation-1",
						source: "dembrane-present-deck",
						type: "opening",
						version: 1,
					},
					origin: "https://example.test",
					source,
				},
				{
					origin: "https://example.test",
					presentationId: "presentation-1",
					source,
				},
			),
		).toBe(true);
	});
	it("isolates authenticated draft previews from published public URLs", () => {
		const draft = audienceUrls({
			draft: true,
			presentationId: "presentation-1",
		});
		expect(draft?.deck).toContain("/present/presentation-1/draft/deck/");
		expect(draft?.audience).toContain("/present/presentation-1/draft/audience");
		expect(draft?.map).toContain("/present/presentation-1/draft/map");
		expect(audienceUrls({ draft: true, publicToken: "public" })).toEqual(
			audienceUrls({ publicToken: "public" }),
		);
	});
	it("keeps authenticated and public reads on their audience projections", () => {
		expect(audienceUrls({ presentationId: "presentation/id" })).toEqual({
			audience: expect.stringContaining(
				"/v2/bff/present/presentation%2Fid/audience",
			),
			deck: expect.stringContaining("/v2/bff/present/presentation%2Fid/deck/"),
			events: expect.stringContaining(
				"/v2/bff/present/presentation%2Fid/deck/events",
			),
			map: expect.stringContaining("/v2/bff/present/presentation%2Fid/map"),
		});
		expect(audienceUrls({ publicToken: "public token" })).toEqual({
			audience: expect.stringContaining(
				"/v2/popcorn/public/public%20token/audience",
			),
			deck: expect.stringContaining("/v2/popcorn/public/public%20token/"),
			events: expect.stringContaining(
				"/v2/popcorn/public/public%20token/events",
			),
			map: expect.stringContaining("/v2/popcorn/public/public%20token/map"),
		});
	});

	it("sends the versioned identity-bound bridge envelope to one origin", () => {
		const target = { postMessage: vi.fn() };
		const message = deckVisibilityCommand("presentation-1", false);
		postDeckMessage(target, "https://dashboard.example", message);

		expect(target.postMessage).toHaveBeenCalledWith(
			{
				command: "visibility",
				presentationId: "presentation-1",
				source: "dembrane-present-shell",
				version: 1,
				visible: false,
			},
			"https://dashboard.example",
		);
		expect(deckBlockCommand("presentation-1", "tensions")).toMatchObject({
			block: "tensions",
			presentationId: "presentation-1",
			source: "dembrane-present-shell",
			version: 1,
		});
	});

	it("accepts deck readiness only from the bound frame, origin, and identity", () => {
		const frame = {} as Window;
		const data = {
			presentationId: "presentation-1",
			revision: 3,
			source: "dembrane-present-deck",
			type: "ready",
			version: 1,
		};
		const expected = {
			origin: "https://api.example",
			presentationId: "presentation-1",
			source: frame,
		};

		expect(
			isDeckReadyEvent(
				{ data, origin: "https://api.example", source: frame },
				expected,
			),
		).toBe(true);
		expect(
			isDeckReadyEvent(
				{ data, origin: "https://attacker.example", source: frame },
				expected,
			),
		).toBe(false);
		expect(
			isDeckReadyEvent(
				{ data, origin: "https://api.example", source: {} as Window },
				expected,
			),
		).toBe(false);
		expect(
			isDeckReadyEvent(
				{
					data: { ...data, presentationId: "presentation-2" },
					origin: "https://api.example",
					source: frame,
				},
				expected,
			),
		).toBe(false);
	});
});
