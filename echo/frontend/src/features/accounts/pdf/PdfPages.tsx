import { Trans } from "@lingui/react/macro";
import { Box, Loader, Stack, Text } from "@mantine/core";
import {
	GlobalWorkerOptions,
	getDocument,
	type PDFDocumentProxy,
	type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type ReactNode, useEffect, useRef, useState } from "react";

// pdf.js and its worker load with this module, which only the signing screen and the
// staff field editor import, so neither the portal nor the dashboard shell pays for them.
GlobalWorkerOptions.workerSrc = workerUrl;

export interface PageBox {
	page: number;
	width: number;
	height: number;
}

/**
 * Renders every page of a PDF at the container's width, with an overlay layer per page
 * sized to it. Fields are positioned in page fractions, so the overlay only needs the
 * rendered size.
 */
export function PdfPages({
	data,
	overlay,
	gap = 16,
}: {
	data: Uint8Array;
	overlay?: (box: PageBox) => ReactNode;
	gap?: number;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setWidth(Math.floor(entry.contentRect.width));
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		let live = true;
		// pdf.js takes ownership of the buffer it is given; hand it a copy.
		const task = getDocument({ data: data.slice() });
		task.promise.then(
			(doc) => {
				if (live) setPdf(doc);
			},
			() => {
				if (live) setFailed(true);
			},
		);
		return () => {
			live = false;
			void task.destroy();
		};
	}, [data]);

	return (
		<Box ref={containerRef} w="100%">
			{failed && (
				<Text c="red" size="sm">
					<Trans>
						This document could not be shown. Reload the page to try again.
					</Trans>
				</Text>
			)}
			{!pdf && !failed && (
				<Stack align="center" py="xl">
					<Loader size="sm" />
				</Stack>
			)}
			{pdf && width > 0 && (
				<Stack gap={gap}>
					{Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((n) => (
						<PdfPage
							key={n}
							pdf={pdf}
							page={n}
							width={width}
							overlay={overlay}
						/>
					))}
				</Stack>
			)}
		</Box>
	);
}

function PdfPage({
	pdf,
	page,
	width,
	overlay,
}: {
	pdf: PDFDocumentProxy;
	page: number;
	width: number;
	overlay?: (box: PageBox) => ReactNode;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [height, setHeight] = useState<number | null>(null);

	useEffect(() => {
		let live = true;
		let render: RenderTask | null = null;
		pdf.getPage(page).then((p) => {
			if (!live) return;
			const base = p.getViewport({ scale: 1 });
			const cssHeight = Math.round((width * base.height) / base.width);
			setHeight(cssHeight);
			const ratio = window.devicePixelRatio || 1;
			const viewport = p.getViewport({ scale: (width / base.width) * ratio });
			const canvas = canvasRef.current;
			if (!canvas) return;
			canvas.width = Math.floor(viewport.width);
			canvas.height = Math.floor(viewport.height);
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			render = p.render({ canvasContext: ctx, viewport });
			render.promise.catch(() => {
				// Cancelled by a resize; the next effect renders again.
			});
		});
		return () => {
			live = false;
			render?.cancel();
		};
	}, [pdf, page, width]);

	return (
		<Box
			pos="relative"
			w={width}
			h={height ?? Math.round(width * Math.SQRT2)}
			data-pdf-page={page}
			style={{
				background: "white",
				borderRadius: 2,
				boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
			}}
		>
			<canvas
				ref={canvasRef}
				style={{ display: "block", height: "100%", width: "100%" }}
			/>
			{height !== null && overlay && (
				<Box pos="absolute" inset={0}>
					{overlay({ height, page, width })}
				</Box>
			)}
		</Box>
	);
}
