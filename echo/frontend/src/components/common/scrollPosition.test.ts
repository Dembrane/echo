// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
	BOTTOM_THRESHOLD_PX,
	evaluateScrollPosition,
	resolveScrollContainer,
} from "./scrollPosition";

it("hides the button when there is nothing to scroll", () => {
	const result = evaluateScrollPosition({
		clientHeight: 800,
		scrollHeight: 802,
		scrollTop: 0,
	});
	expect(result.scrollable).toBe(false);
	expect(result.showScrollButton).toBe(false);
	expect(result.isAtBottom).toBe(true);
});

it("hides the button while parked at the bottom of a long thread", () => {
	const result = evaluateScrollPosition({
		clientHeight: 800,
		scrollHeight: 4000,
		scrollTop: 3200,
	});
	expect(result.scrollable).toBe(true);
	expect(result.isAtBottom).toBe(true);
	expect(result.showScrollButton).toBe(false);
});

it("treats a small gap from the bottom as still at the bottom", () => {
	const result = evaluateScrollPosition({
		clientHeight: 800,
		scrollHeight: 4000,
		scrollTop: 3200 - BOTTOM_THRESHOLD_PX,
	});
	expect(result.isAtBottom).toBe(true);
	expect(result.showScrollButton).toBe(false);
});

it("shows the button once scrolled up past the threshold", () => {
	const result = evaluateScrollPosition({
		clientHeight: 800,
		scrollHeight: 4000,
		scrollTop: 1000,
	});
	expect(result.distanceFromBottom).toBe(2200);
	expect(result.isAtBottom).toBe(false);
	expect(result.showScrollButton).toBe(true);
});

it("resolves an overflow container even before it has anything to scroll", () => {
	// Resolution happens at mount, when a chat thread is often still empty.
	// The container must be found by its overflow style alone; requiring
	// scrollHeight > clientHeight here would bind listeners to the wrong
	// target forever.
	const container = document.createElement("div");
	container.style.overflowY = "auto";
	document.body.append(container);
	expect(resolveScrollContainer(container)).toBe(container);
	container.remove();
});

it("walks up to the nearest overflow ancestor", () => {
	const outer = document.createElement("div");
	outer.style.overflowY = "scroll";
	const inner = document.createElement("div");
	outer.append(inner);
	document.body.append(outer);
	expect(resolveScrollContainer(inner)).toBe(outer);
	outer.remove();
});

it("falls back to the scrolling element when no ancestor scrolls", () => {
	const orphan = document.createElement("div");
	document.body.append(orphan);
	expect(resolveScrollContainer(orphan)).toBe(
		document.scrollingElement ?? document.documentElement,
	);
	orphan.remove();
});

it("returns null for a null element", () => {
	expect(resolveScrollContainer(null)).toBeNull();
});
