import { Trans } from "@lingui/react/macro";
import { Alert, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import {
	GlobalWorkerOptions,
	getDocument,
	type PageViewport,
	type PDFDocumentProxy,
	type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
	Children,
	isValidElement,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

// pdf.js and its worker load with this module, which only the signing screen and the
// staff field editor import, so neither the portal nor the dashboard shell pays for them.
GlobalWorkerOptions.workerSrc = workerUrl;

export interface PageBox {
	page: number;
	width: number;
	height: number;
}

export interface PageLink {
	href: string;
	left: number;
	top: number;
	width: number;
	height: number;
}

// Only addresses a person would expect to open from a document; anything else a PDF can
// carry (scripts, local files) stays inert.
const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * The clickable links of one page, in the pixels of the viewport it is drawn at. The canvas
 * has no link layer of its own, so this is what makes the links printed in a document work.
 */
export function pageLinks(
	annotations: ReadonlyArray<Record<string, unknown>>,
	viewport: Pick<PageViewport, "convertToViewportRectangle">,
): PageLink[] {
	const links: PageLink[] = [];
	for (const a of annotations) {
		const href = typeof a.url === "string" ? a.url : "";
		if (a.subtype !== "Link" || !SAFE_LINK.test(href)) continue;
		if (!Array.isArray(a.rect) || a.rect.length !== 4) continue;
		const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(
			a.rect as number[],
		);
		links.push({
			height: Math.abs(y2 - y1),
			href,
			left: Math.min(x1, x2),
			top: Math.min(y1, y2),
			width: Math.abs(x2 - x1),
		});
	}
	return links;
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
	fileHref,
	links = true,
}: {
	data: Uint8Array;
	overlay?: (box: PageBox) => ReactNode;
	gap?: number;
	/** Off where fields are placed and dragged: a link under the pointer must not steal it. */
	links?: boolean;
	/** Offered as a way out when the browser cannot draw the file. */
	fileHref?: string | null;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
	const [failed, setFailed] = useState(false);
	// Bumped by "Try again" to parse the same bytes once more.
	const [attempt, setAttempt] = useState(0);

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
		setFailed(false);
		setPdf(null);
		void attempt;
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
	}, [data, attempt]);

	return (
		<Box ref={containerRef} w="100%">
			{failed && (
				<Alert color="orange" data-testid="pdf-render-failed">
					<Stack gap="xs">
						<Text size="sm">
							<Trans>
								Your browser could not display this document. Try again, or open
								the PDF on its own.
							</Trans>
						</Text>
						<Group gap="xs">
							<Button
								size="xs"
								variant="light"
								onClick={() => setAttempt((n) => n + 1)}
							>
								<Trans>Try again</Trans>
							</Button>
							{fileHref && (
								<Button
									size="xs"
									variant="subtle"
									component="a"
									href={fileHref}
									target="_blank"
									rel="noreferrer"
								>
									<Trans>Open the PDF</Trans>
								</Button>
							)}
						</Group>
					</Stack>
				</Alert>
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
							links={links}
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
	links: withLinks,
}: {
	pdf: PDFDocumentProxy;
	page: number;
	width: number;
	overlay?: (box: PageBox) => ReactNode;
	links: boolean;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [height, setHeight] = useState<number | null>(null);
	const [links, setLinks] = useState<PageLink[]>([]);

	useEffect(() => {
		let live = true;
		let render: RenderTask | null = null;
		pdf.getPage(page).then((p) => {
			if (!live) return;
			const base = p.getViewport({ scale: 1 });
			const cssHeight = Math.round((width * base.height) / base.width);
			setHeight(cssHeight);
			// Same scale as the page box, so the links sit on the words they belong to.
			const cssViewport = p.getViewport({ scale: width / base.width });
			p.getAnnotations().then(
				(annotations) => {
					if (live) setLinks(pageLinks(annotations, cssViewport));
				},
				() => {
					if (live) setLinks([]);
				},
			);
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
			{/* Under the fields: where a field and a link meet, the field gets the click. */}
			{withLinks && links.length > 0 && (
				<Box
					pos="absolute"
					inset={0}
					data-pdf-links=""
					style={{ pointerEvents: "none" }}
				>
					{links.map((l) => (
						<a
							key={`${l.href}-${l.left}-${l.top}`}
							href={l.href}
							target="_blank"
							rel="noopener noreferrer"
							data-pdf-link=""
							style={{
								height: l.height,
								left: l.left,
								pointerEvents: "auto",
								position: "absolute",
								top: l.top,
								width: l.width,
							}}
						>
							<span
								style={{
									height: 1,
									overflow: "hidden",
									position: "absolute",
									width: 1,
								}}
							>
								{l.href}
							</span>
						</a>
					))}
				</Box>
			)}
			{height !== null && overlay && (
				// Only the fields take the pointer, so the links between them stay reachable.
				<Box
					pos="absolute"
					inset={0}
					data-pdf-overlay=""
					style={{ pointerEvents: "none" }}
				>
					{Children.toArray(overlay({ height, page, width })).map((node) => (
						<span
							key={isValidElement(node) ? node.key : undefined}
							style={{ display: "contents", pointerEvents: "auto" }}
						>
							{node}
						</span>
					))}
				</Box>
			)}
		</Box>
	);
}
