// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const annotations = vi.hoisted(() => ({ current: [] as unknown[] }));

// A 600 x 800 point page; the viewport scale is the only thing the links depend on.
vi.mock("pdfjs-dist", () => {
	const viewport = (scale: number) => ({
		convertToViewportRectangle: ([x1, y1, x2, y2]: number[]) => [
			x1 * scale,
			(800 - y1) * scale,
			x2 * scale,
			(800 - y2) * scale,
		],
		height: 800 * scale,
		width: 600 * scale,
	});
	const page = {
		getAnnotations: async () => annotations.current,
		getViewport: ({ scale }: { scale: number }) => viewport(scale),
		render: () => ({ cancel: () => {}, promise: Promise.resolve() }),
	};
	return {
		GlobalWorkerOptions: {},
		getDocument: () => ({
			destroy: async () => {},
			promise: Promise.resolve({ getPage: async () => page, numPages: 1 }),
		}),
	};
});
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

import { PdfPages } from "./PdfPages";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
	// The page is drawn at the container width: 300 css pixels, half the page's points.
	globalThis.ResizeObserver = class {
		constructor(private cb: (e: unknown[]) => void) {}
		observe() {
			this.cb([{ contentRect: { width: 300 } }]);
		}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	HTMLCanvasElement.prototype.getContext = (() =>
		null) as unknown as HTMLCanvasElement["getContext"];
});
afterEach(cleanup);

const show = (props: Partial<Parameters<typeof PdfPages>[0]> = {}) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<PdfPages data={new Uint8Array([1])} {...props} />
			</MantineProvider>
		</I18nProvider>,
	);

describe("links inside a document page", () => {
	it("lays a clickable link over the words it belongs to", async () => {
		annotations.current = [
			{
				rect: [100, 600, 300, 620],
				subtype: "Link",
				url: "https://example.com/sla",
			},
		];
		const { container } = show();
		await waitFor(() =>
			expect(container.querySelectorAll("a[data-pdf-link]").length).toBe(1),
		);
		const link = container.querySelector(
			"a[data-pdf-link]",
		) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("https://example.com/sla");
		expect(link.target).toBe("_blank");
		expect(link.rel).toBe("noopener noreferrer");
		// Half scale: x 50 to 150, and y flips from the bottom edge (800 - 620) / 2 = 90.
		expect(link.style.left).toBe("50px");
		expect(link.style.top).toBe("90px");
		expect(link.style.width).toBe("100px");
		expect(link.style.height).toBe("10px");
	});

	it("ignores annotations that are not web or mail links", async () => {
		annotations.current = [
			{ rect: [0, 0, 10, 10], subtype: "Widget", url: "https://example.com/a" },
			{ dest: "page-2", rect: [0, 0, 10, 10], subtype: "Link" },
			{
				rect: [0, 0, 10, 10],
				subtype: "Link",
				url: "javascript:alert(1)",
			},
			{
				rect: [0, 20, 10, 30],
				subtype: "Link",
				url: "mailto:hello@example.com",
			},
		];
		const { container } = show();
		await waitFor(() =>
			expect(container.querySelectorAll("a[data-pdf-link]").length).toBe(1),
		);
		expect(
			container.querySelector("a[data-pdf-link]")?.getAttribute("href"),
		).toBe("mailto:hello@example.com");
	});
});

// jsdom does no hit testing, so this walks up the way the browser resolves the property:
// the nearest ancestor that sets pointer-events decides.
const takesPointer = (el: Element) => {
	for (let n: Element | null = el; n; n = n.parentElement) {
		const v = (n as HTMLElement).style?.pointerEvents;
		if (v) return v !== "none";
	}
	return true;
};

describe("links and fields on the same page", () => {
	const overlapping = [
		{
			rect: [100, 600, 300, 620],
			subtype: "Link",
			url: "https://example.com/sla",
		},
	];

	it("gives a field over a link the click, and leaves the rest of the link reachable", async () => {
		annotations.current = overlapping;
		const onField = vi.fn();
		const { container, getByTestId } = show({
			overlay: () => (
				<button
					type="button"
					data-testid="field"
					style={{ left: 50, position: "absolute", top: 90 }}
					onClick={onField}
				/>
			),
		});
		await waitFor(() =>
			expect(container.querySelectorAll("a[data-pdf-link]").length).toBe(1),
		);
		const field = getByTestId("field");
		fireEvent.click(field);
		expect(onField).toHaveBeenCalledTimes(1);
		expect(takesPointer(field)).toBe(true);
		// The link layer sits before the field layer, so the field is painted over it.
		const layers = Array.from(
			container.querySelector("[data-pdf-page]")?.children ?? [],
		);
		const links = container.querySelector("[data-pdf-links]") as Element;
		const fields = container.querySelector("[data-pdf-overlay]") as Element;
		expect(layers.indexOf(links)).toBeLessThan(layers.indexOf(fields));
		// Neither layer blocks the page, so the part of the link outside a field still opens.
		expect(takesPointer(fields)).toBe(false);
		expect(
			takesPointer(container.querySelector("a[data-pdf-link]") as Element),
		).toBe(true);
	});

	it("draws no links where fields are placed", async () => {
		annotations.current = overlapping;
		const { container } = show({ links: false, overlay: () => <i /> });
		await waitFor(() =>
			expect(container.querySelector("[data-pdf-overlay]")).toBeTruthy(),
		);
		expect(container.querySelector("a[data-pdf-link]")).toBeNull();
	});
});
