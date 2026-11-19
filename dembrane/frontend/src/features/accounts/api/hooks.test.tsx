// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useLegalHref } from "./hooks";

// A pinned legal text's href: the API route, or in fixture mode (no server) a
// small page built in the browser.
const mode = vi.hoisted(() => ({ fixture: false }));
vi.mock("./client", async (importOriginal) => ({
	...(await importOriginal<typeof import("./client")>()),
	get FIXTURE_MODE() {
		return mode.fixture;
	},
}));

const pages: string[] = [];
beforeAll(() => {
	let n = 0;
	URL.createObjectURL = vi.fn((blob: Blob) => {
		void blob.text().then((text) => pages.push(text));
		n += 1;
		return `blob:page-${n}`;
	});
	URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
	mode.fixture = false;
});

const pin = (version: string) => ({
	sha256: `sha-${version}`,
	text_url: `/api/legal/terms/${version}`,
	version,
});

it("is the API route for a pinned text", () => {
	const { result } = renderHook(() => useLegalHref(pin("1.0")));
	expect(result.current).toContain("/api/legal/terms/1.0");
});

it("is nothing when the pin has no text", () => {
	const { result } = renderHook(() =>
		useLegalHref({ ...pin("1.0"), text_url: null }),
	);
	expect(result.current).toBeNull();
});

it("is a page of its own in fixture mode, the same one on every render", async () => {
	mode.fixture = true;
	const { result, rerender } = renderHook(() => useLegalHref(pin("2.0")));
	const href = result.current;
	expect(href).toMatch(/^blob:/);
	rerender();
	expect(result.current).toBe(href);
	await vi.waitFor(() =>
		expect(pages.some((p) => p.includes("Version 2.0"))).toBe(true),
	);
});
