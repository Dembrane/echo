import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Paper, Stack, Text } from "@mantine/core";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import { testId } from "@/lib/testUtils";
import type { CanvasGeneration } from "./hooks";
import { assembleCanvasDocument } from "./kit";

type CanvasFrameProps = {
	generation?: CanvasGeneration | null;
	cadenceMinutes?: number | null;
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

function generationAgeLine(
	generation: CanvasGeneration,
	cadenceMinutes?: number | null,
) {
	if (!cadenceMinutes || cadenceMinutes <= 0) return null;
	const createdAt = new Date(generation.created_at);
	if (Number.isNaN(createdAt.getTime())) return null;
	const staleAfterMs = cadenceMinutes * 2 * 60 * 1000;
	if (Date.now() - createdAt.getTime() <= staleAfterMs) return null;
	return t`Last updated ${formatDistanceToNow(createdAt, { addSuffix: true })}`;
}

export const CanvasFrame = ({
	generation,
	cadenceMinutes,
}: CanvasFrameProps) => {
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [height, setHeight] = useState(520);
	const generationId = generation?.id;

	useEffect(() => {
		if (!generationId) return;
		setHeight(520);
	}, [generationId]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (!isHeightMessage(event.data)) return;
			setHeight(Math.max(360, Math.min(6000, Math.ceil(event.data.height))));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	const srcDoc = useMemo(() => {
		if (!generation || generation.status === "error") return null;
		return assembleCanvasDocument(generation.content_html);
	}, [generation]);

	const staleLine = generation
		? generationAgeLine(generation, cadenceMinutes)
		: null;

	if (!generation) {
		return (
			<Paper
				withBorder
				className="rounded-md"
				p="xl"
				{...testId("canvas-frame-empty")}
			>
				<Stack gap="xs" align="center" py="xl">
					<Text size="lg" fw={500}>
						<Trans>Preparing this canvas</Trans>
					</Text>
					<Text size="sm" ta="center">
						<Trans>A first version will appear here when it is ready.</Trans>
					</Text>
				</Stack>
			</Paper>
		);
	}

	if (generation.status === "error") {
		return (
			<Paper
				withBorder
				className="rounded-md"
				p="xl"
				style={{ borderColor: "var(--mantine-color-red-3)" }}
				{...testId("canvas-frame-error")}
			>
				<Stack gap="xs" align="center" py="xl">
					<Text size="lg" fw={500}>
						<Trans>This canvas could not update.</Trans>
					</Text>
					<Text size="sm" ta="center">
						<Trans>The previous versions are still available below.</Trans>
					</Text>
				</Stack>
			</Paper>
		);
	}

	return (
		<Stack gap="xs">
			{staleLine ? (
				<Text size="sm" fs="italic" {...testId("canvas-frame-stale-line")}>
					{staleLine}
				</Text>
			) : null}
			<iframe
				ref={iframeRef}
				title={t`Canvas preview`}
				sandbox="allow-scripts"
				srcDoc={srcDoc ?? ""}
				className="block w-full rounded-md border"
				style={{
					backgroundColor: "var(--app-background)",
					borderColor: "var(--mantine-color-primary-light)",
					height,
				}}
				{...testId("canvas-frame-iframe")}
			/>
		</Stack>
	);
};
