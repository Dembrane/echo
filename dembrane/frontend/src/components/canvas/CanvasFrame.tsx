import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Stack, Text } from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { PARTICIPANT_BASE_URL } from "@/config";
import { useWhitelabelLogo } from "@/hooks/useWhitelabelLogo";
import { testId } from "@/lib/testUtils";
import type { CanvasGeneration } from "./hooks";
import { assembleCanvasDocument } from "./kit";

type CanvasFrameProps = {
	generation?: CanvasGeneration | null;
	projectId?: string | null;
	fullscreen?: boolean;
};

function isHeightMessage(data: unknown): data is {
	type: "dembrane:canvas:height";
	height: number;
} {
	return (
		typeof data === "object" &&
		data !== null &&
		"type" in data &&
		(data as { type?: unknown }).type === "dembrane:canvas:height" &&
		"height" in data &&
		typeof (data as { height?: unknown }).height === "number" &&
		Number.isFinite((data as { height: number }).height)
	);
}

export const CanvasFrame = ({
	generation,
	projectId,
	fullscreen,
}: CanvasFrameProps) => {
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [height, setHeight] = useState(520);
	const [brandLogoDataUrl, setBrandLogoDataUrl] = useState<string | null>(null);
	const { logoUrl } = useWhitelabelLogo();
	const generationId = generation?.id;

	useEffect(() => {
		if (!generationId) return;
		setHeight(520);
	}, [generationId]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (!isHeightMessage(event.data)) return;
			setHeight(Math.max(320, Math.ceil(event.data.height)));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	useEffect(() => {
		let cancelled = false;
		setBrandLogoDataUrl(null);
		if (!logoUrl) return;
		fetch(logoUrl, { credentials: "include" })
			.then((response) => {
				if (!response.ok) throw new Error("Failed to load logo");
				return response.blob();
			})
			.then(
				(blob) =>
					new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(String(reader.result));
						reader.onerror = () => reject(reader.error);
						reader.readAsDataURL(blob);
					}),
			)
			.then((dataUrl) => {
				if (!cancelled) setBrandLogoDataUrl(dataUrl);
			})
			.catch(() => {
				if (!cancelled) setBrandLogoDataUrl(null);
			});
		return () => {
			cancelled = true;
		};
	}, [logoUrl]);

	const srcDoc = useMemo(() => {
		if (!generation || generation.status === "error") return null;
		return assembleCanvasDocument(generation.content_html, {
			brandLogoDataUrl,
			portalBaseUrl: PARTICIPANT_BASE_URL,
			portalProjectId: projectId,
		});
	}, [generation, brandLogoDataUrl, projectId]);

	const rule = "var(--app-stroke) solid var(--app-rule-color)";

	if (!generation) {
		return (
			<Text size="sm" c="dimmed" {...testId("canvas-frame-empty")}>
				<Trans>
					Preparing this canvas. A first version will appear here when it is
					ready.
				</Trans>
			</Text>
		);
	}

	if (generation.status === "error") {
		return (
			<Alert
				color="red"
				title={t`This canvas could not update.`}
				{...testId("canvas-frame-error")}
			>
				<Text size="sm">
					<Trans>The previous versions are still available below.</Trans>
				</Text>
			</Alert>
		);
	}

	return (
		<Stack gap={fullscreen ? 0 : "xs"} h={fullscreen ? "100%" : undefined}>
			<iframe
				ref={iframeRef}
				aria-label={t`Canvas preview`}
				sandbox="allow-scripts"
				srcDoc={srcDoc ?? ""}
				className="block w-full"
				style={{
					// Read: a rule above and below, none in fullscreen.
					borderBottom: fullscreen ? "0" : rule,
					borderLeft: "0",
					borderRight: "0",
					borderTop: fullscreen ? "0" : rule,
					height: fullscreen ? "100%" : height,
					minHeight: fullscreen ? "100dvh" : undefined,
					width: fullscreen ? "100dvw" : undefined,
				}}
				{...testId("canvas-frame-iframe")}
			/>
		</Stack>
	);
};
