// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { consumeChatPrefill, sanitizeChatPrefill } from "./prefill";

describe("chat prefill", () => {
	it("strips markup and trims plain text", () => {
		expect(sanitizeChatPrefill("  <b>Hello</b> <script>x</script>  ")).toBe(
			"Hello x",
		);
	});

	it("caps prefill text at 500 characters", () => {
		expect(sanitizeChatPrefill("x".repeat(520))).toHaveLength(500);
	});

	it("consumes the prefill query while preserving other params", () => {
		const result = consumeChatPrefill(
			"?prefill=Need%20a%20new%20tab&panel=versions",
		);
		expect(result).toEqual({
			prefill: "Need a new tab",
			search: "?panel=versions",
		});
	});

	it("still consumes empty or markup-only prefill values", () => {
		const result = consumeChatPrefill("?prefill=%3Cbr%3E");
		expect(result).toEqual({ prefill: null, search: "" });
	});

	it("drops angle brackets entirely when no DOM is available", () => {
		const original = globalThis.DOMParser;
		vi.stubGlobal("DOMParser", undefined);
		try {
			expect(sanitizeChatPrefill("a <scr<script>ipt> b")).toBe(
				"a scrscriptipt b",
			);
		} finally {
			vi.stubGlobal("DOMParser", original);
		}
	});
});
