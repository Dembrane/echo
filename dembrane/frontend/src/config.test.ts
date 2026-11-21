import { describe, expect, it } from "vitest";
import { isPortalPreview, PREVIEW_FRAME_NAME } from "./config";

const top = {};
const win = (
	pathname: string,
	opts: { framed?: boolean; name?: string } = {},
) => ({
	location: { pathname },
	name: opts.name ?? "",
	self: opts.framed === false ? top : {},
	top,
});

describe("isPortalPreview", () => {
	it("a top-level window is never the preview", () => {
		expect(
			isPortalPreview(
				win("/nl-NL/p1/preview", { framed: false, name: PREVIEW_FRAME_NAME }),
				true,
			),
		).toBe(false);
	});

	it("a framed page at the preview address is the preview", () => {
		expect(isPortalPreview(win("/nl-NL/p1/preview"), true)).toBe(true);
		expect(isPortalPreview(win("/p1/preview/"), true)).toBe(true);
	});

	it("any framed page in the dashboard's preview frame is the preview", () => {
		expect(
			isPortalPreview(
				win("/nl-NL/p1/start", { name: PREVIEW_FRAME_NAME }),
				true,
			),
		).toBe(true);
	});

	it("a framed page with neither is not", () => {
		expect(
			isPortalPreview(win("/nl-NL/p1/start", { name: "other" }), true),
		).toBe(false);
	});

	it("only the participant portal has a preview", () => {
		expect(isPortalPreview(win("/nl-NL/p1/preview"), false)).toBe(false);
		expect(isPortalPreview(undefined, true)).toBe(false);
	});
});
