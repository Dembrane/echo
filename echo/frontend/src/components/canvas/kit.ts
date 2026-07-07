import d3Bundle from "../../../node_modules/d3/dist/d3.min.js?raw";
import kitCss from "./kit.css?raw";

export const CANVAS_FRAME_CSP =
	"default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data:; font-src data:;";

const HEIGHT_REPORTER_SCRIPT = `
(() => {
	const report = () => {
		const height = Math.max(
			document.documentElement.scrollHeight,
			document.body ? document.body.scrollHeight : 0,
			320
		);
		window.parent.postMessage({ type: "dembrane:canvas:height", height }, "*");
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

export function assembleCanvasDocument(contentHtml: string): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(CANVAS_FRAME_CSP)}">
	<style>${kitCss}</style>
	<script>${escapeScriptContent(d3Bundle)}</script>
</head>
<body>
	<main class="dembrane-canvas-root">
		${contentHtml}
	</main>
	<script>${HEIGHT_REPORTER_SCRIPT}</script>
</body>
</html>`;
}
