import d3Bundle from "../../../node_modules/d3/dist/d3.min.js?raw";
import dembraneLogoRaw from "../../assets/dembrane-logo-new.svg?raw";
import dmSansFontDataUrl from "../../fonts/DMSans-Light.woff2?inline";
import kitCss from "./kit.css?raw";
import qrcode from "qrcode-generator";

export const CANVAS_FRAME_CSP =
	"default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data:; font-src data:;";

const HEIGHT_REPORTER_SCRIPT = `
(() => {
	let frame = 0;
	const measure = () => {
		const body = document.body;
		if (!body) return 320;
		const rectHeight = Math.ceil(body.getBoundingClientRect().height);
		return Math.max(body.scrollHeight, body.offsetHeight, rectHeight, 320);
	};
	const reportNow = () => {
		frame = 0;
		const height = Math.max(
			measure(),
			320
		);
		window.parent.postMessage({ type: "dembrane:canvas:height", height }, "*");
	};
	const report = () => {
		if (frame) return;
		frame = requestAnimationFrame(reportNow);
	};
	window.addEventListener("load", report);
	window.addEventListener("resize", report);
	new ResizeObserver(report).observe(document.documentElement);
	new MutationObserver(report).observe(document.documentElement, {
		attributes: true,
		childList: true,
		subtree: true
	});
	requestAnimationFrame(report);
	setTimeout(report, 250);
})();
`;

type CanvasAssemblyOptions = {
	brandLogoDataUrl?: string | null;
	portalBaseUrl?: string | null;
	portalProjectId?: string | null;
};

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeScriptContent(value: string): string {
	return value.replace(/<\/script/gi, "<\\/script");
}

function svgToDataUrl(svg: string): string {
	return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, " ").trim())}`;
}

const DEMBRANE_LOGO_DATA_URL = svgToDataUrl(dembraneLogoRaw);

function kitCssWithAssets(): string {
	return kitCss.replace("__DM_SANS_DATA_URL__", dmSansFontDataUrl);
}

function qrSvgDataUrl(value: string): string {
	const qr = qrcode(0, "M");
	qr.addData(value);
	qr.make();
	return svgToDataUrl(qr.createSvgTag(5, 1));
}

function isAllowedPortalQrUrl(
	value: string,
	options: CanvasAssemblyOptions,
): boolean {
	if (!options.portalBaseUrl || !options.portalProjectId) return false;
	try {
		const candidate = new URL(value);
		const portal = new URL(options.portalBaseUrl);
		if (candidate.origin !== portal.origin) return false;
		const segments = candidate.pathname.split("/").filter(Boolean);
		return (
			segments.length >= 3 &&
			segments[1] === options.portalProjectId &&
			segments[2] === "start"
		);
	} catch {
		return false;
	}
}

function renderCanvasQr(url: string): string {
	return `<span class="canvas-qr" role="img" aria-label="Portal QR code"><img alt="Portal QR code" src="${escapeHtmlAttribute(qrSvgDataUrl(url))}"></span>`;
}

function assembleContentHtml(
	contentHtml: string,
	options: CanvasAssemblyOptions,
): string {
	if (typeof window === "undefined" || typeof DOMParser === "undefined") {
		return contentHtml;
	}
	const doc = new DOMParser().parseFromString(
		`<template>${contentHtml}</template>`,
		"text/html",
	);
	const template = doc.querySelector("template");
	if (!template) return contentHtml;
	for (const node of template.content.querySelectorAll(".canvas-qr")) {
		const url = node.getAttribute("data-url")?.trim() ?? "";
		if (!isAllowedPortalQrUrl(url, options)) {
			node.remove();
			continue;
		}
		const wrapper = doc.createElement("span");
		wrapper.innerHTML = renderCanvasQr(url);
		const qrNode = wrapper.firstElementChild;
		if (qrNode) node.replaceWith(qrNode);
	}
	return template.innerHTML;
}

export function assembleCanvasDocument(
	contentHtml: string,
	options: CanvasAssemblyOptions = {},
): string {
	const assembledContent = assembleContentHtml(contentHtml, options);
	const logoDataUrl = options.brandLogoDataUrl || DEMBRANE_LOGO_DATA_URL;
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(CANVAS_FRAME_CSP)}">
	<style>${kitCssWithAssets()}</style>
	<script>${escapeScriptContent(d3Bundle)}</script>
</head>
<body>
	<header class="dembrane-canvas-brand" aria-hidden="true">
		<img src="${escapeHtmlAttribute(logoDataUrl)}" alt="">
	</header>
	<main class="dembrane-canvas-root">
		${assembledContent}
	</main>
	<script>${HEIGHT_REPORTER_SCRIPT}</script>
</body>
</html>`;
}
