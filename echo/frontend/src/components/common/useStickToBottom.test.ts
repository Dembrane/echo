// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStickToBottom } from "./useStickToBottom";

/** jsdom has no ResizeObserver; grab an instance and call trigger() to simulate one firing. */
class MockResizeObserver {
	static instances: MockResizeObserver[] = [];
	callback: ResizeObserverCallback;
	observedTargets: Element[] = [];
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		MockResizeObserver.instances.push(this);
	}
	observe(target: Element) {
		this.observedTargets.push(target);
	}
	unobserve(target: Element) {
		this.observedTargets = this.observedTargets.filter((t) => t !== target);
	}
	disconnect() {
		this.observedTargets = [];
	}
	trigger() {
		this.callback(
			[] as unknown as ResizeObserverEntry[],
			this as unknown as ResizeObserver,
		);
	}
}

/** jsdom reports 0 for these on every element; stub the ones a test needs. */
const setMetrics = (
	el: HTMLElement,
	metrics: { clientHeight: number; scrollHeight: number; scrollTop: number },
) => {
	Object.defineProperty(el, "clientHeight", {
		configurable: true,
		value: metrics.clientHeight,
	});
	Object.defineProperty(el, "scrollHeight", {
		configurable: true,
		value: metrics.scrollHeight,
	});
	Object.defineProperty(el, "scrollTop", {
		configurable: true,
		value: metrics.scrollTop,
		writable: true,
	});
};

beforeEach(() => {
	MockResizeObserver.instances = [];
	window.ResizeObserver =
		MockResizeObserver as unknown as typeof ResizeObserver;
	// jsdom's Element has no scrollTo implementation at all.
	Element.prototype.scrollTo =
		Element.prototype.scrollTo ?? vi.fn<(...args: unknown[]) => void>();
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

it("measures the container on mount and reflects scroll position", () => {
	const container = document.createElement("div");
	container.style.overflowY = "auto";
	const anchor = document.createElement("div");
	container.append(anchor);
	document.body.append(container);
	setMetrics(container, {
		clientHeight: 800,
		scrollHeight: 4000,
		scrollTop: 1000,
	});

	const anchorRef = createRef<HTMLElement>();
	anchorRef.current = anchor;

	const { result } = renderHook(() => useStickToBottom(anchorRef));

	expect(result.current.showScrollButton).toBe(true);
	expect(result.current.isAtBottom).toBe(false);
});

it("updates on a scroll event fired on the resolved container", () => {
	const container = document.createElement("div");
	container.style.overflowY = "auto";
	const anchor = document.createElement("div");
	container.append(anchor);
	document.body.append(container);
	setMetrics(container, {
		clientHeight: 800,
		scrollHeight: 4000,
		scrollTop: 1000,
	});

	const anchorRef = createRef<HTMLElement>();
	anchorRef.current = anchor;

	const { result } = renderHook(() => useStickToBottom(anchorRef));
	expect(result.current.showScrollButton).toBe(true);

	act(() => {
		setMetrics(container, {
			clientHeight: 800,
			scrollHeight: 4000,
			scrollTop: 3200,
		});
		container.dispatchEvent(new Event("scroll"));
	});

	expect(result.current.showScrollButton).toBe(false);
	expect(result.current.isAtBottom).toBe(true);
});

it("attaches the scroll listener to window, not the element, when the container is the scrolling element", () => {
	const anchor = document.createElement("div");
	document.body.append(anchor);
	// No overflow ancestor, so this falls back to document.documentElement.
	setMetrics(document.documentElement, {
		clientHeight: 800,
		scrollHeight: 4000,
		scrollTop: 1000,
	});

	const windowAddSpy = vi.spyOn(window, "addEventListener");
	const anchorRef = createRef<HTMLElement>();
	anchorRef.current = anchor;

	renderHook(() => useStickToBottom(anchorRef));

	const scrollListenerOnWindow = windowAddSpy.mock.calls.some(
		([eventName]) => eventName === "scroll",
	);
	expect(scrollListenerOnWindow).toBe(true);
});

it("re-measures when the ResizeObserver fires (content growth)", () => {
	const container = document.createElement("div");
	container.style.overflowY = "auto";
	const anchor = document.createElement("div");
	container.append(anchor);
	document.body.append(container);
	setMetrics(container, { clientHeight: 800, scrollHeight: 802, scrollTop: 0 });

	const anchorRef = createRef<HTMLElement>();
	anchorRef.current = anchor;

	const { result } = renderHook(() => useStickToBottom(anchorRef));
	expect(result.current.showScrollButton).toBe(false);

	act(() => {
		// Content grows past scrollable while scrollTop stays put (streaming reply).
		setMetrics(container, {
			clientHeight: 800,
			scrollHeight: 4000,
			scrollTop: 0,
		});
		for (const observer of MockResizeObserver.instances) {
			observer.trigger();
		}
	});

	expect(result.current.showScrollButton).toBe(true);
});

it("caches the resolved container so a later anchor change doesn't re-resolve it", () => {
	const container = document.createElement("div");
	container.style.overflowY = "auto";
	const anchor = document.createElement("div");
	container.append(anchor);
	document.body.append(container);
	setMetrics(container, { clientHeight: 800, scrollHeight: 802, scrollTop: 0 });

	const anchorRef = createRef<HTMLElement>();
	anchorRef.current = anchor;

	const { result } = renderHook(() => useStickToBottom(anchorRef));

	// Detached, no overflow ancestor: re-resolving from this would fall back
	// to document.documentElement instead of the original container.
	const detached = document.createElement("div");
	anchorRef.current = detached;

	act(() => {
		setMetrics(container, {
			clientHeight: 800,
			scrollHeight: 4000,
			scrollTop: 0,
		});
		result.current.measure();
	});

	// Still reflects container's metrics: measure() used the cached one.
	expect(result.current.showScrollButton).toBe(true);
});

it("scrolls the resolved container to its full height", async () => {
	const container = document.createElement("div");
	container.style.overflowY = "auto";
	const anchor = document.createElement("div");
	container.append(anchor);
	document.body.append(container);
	setMetrics(container, {
		clientHeight: 800,
		scrollHeight: 4000,
		scrollTop: 1000,
	});
	const scrollToSpy = vi
		.spyOn(container, "scrollTo")
		.mockImplementation(() => {});

	const anchorRef = createRef<HTMLElement>();
	anchorRef.current = anchor;

	const { result } = renderHook(() => useStickToBottom(anchorRef));

	act(() => {
		result.current.scrollToBottom("smooth");
	});
	// scrollToBottom defers to the next animation frame.
	await new Promise((resolve) => requestAnimationFrame(resolve));

	expect(scrollToSpy).toHaveBeenCalledWith({ behavior: "smooth", top: 4000 });
});

it("attaches listeners once the anchor mounts later, via the wait-for-anchor observer", async () => {
	document.body.setAttribute("data-app-scroll-root", "");

	// Anchor starts unattached, mirroring a loading/picker screen.
	const anchorRef = createRef<HTMLElement>();

	const { result } = renderHook(() => useStickToBottom(anchorRef));
	expect(result.current.showScrollButton).toBe(false);

	const container = document.createElement("div");
	container.style.overflowY = "auto";
	const anchor = document.createElement("div");
	container.append(anchor);
	setMetrics(container, {
		clientHeight: 800,
		scrollHeight: 4000,
		scrollTop: 1000,
	});

	await act(async () => {
		anchorRef.current = anchor;
		// Any mutation re-checks the ref; appending the container is enough.
		document.body.append(container);
		// MutationObserver callbacks are microtask-scheduled.
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(result.current.showScrollButton).toBe(true);

	document.body.removeAttribute("data-app-scroll-root");
});
