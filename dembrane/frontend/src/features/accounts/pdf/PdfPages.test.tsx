// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, waitFor } from "@testing-library/react";
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

const show = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<PdfPages data={new Uint8Array([1])} />
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
