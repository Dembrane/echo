import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Button,
	Group,
	Loader,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDocumentTitle, useFullscreen } from "@mantine/hooks";
import { format } from "date-fns";
import { Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { CanvasFrame } from "@/components/canvas/CanvasFrame";
import {
	type CanvasGeneration,
	useCanvas,
	useCanvasGenerations,
	useRefreshCanvasMutation,
} from "@/components/canvas/hooks";
import { PageContainer } from "@/components/layout/PageContainer";
import { testId } from "@/lib/testUtils";

function loopStatusLine(
	status?: string | null,
	expiresAt?: string | null,
): string {
	if (status === "paused") return t`Paused`;
	if (status === "expired" || status === "ended" || status === "stopped") {
		return t`Ended`;
	}
	if (!expiresAt) return t`Stays up to date`;
	const expiry = new Date(expiresAt);
	if (Number.isNaN(expiry.getTime())) return t`Stays up to date`;
	return t`Stays up to date until ${format(expiry, "HH:mm 'today'")}`;
}

function generationLabel(generation: CanvasGeneration): string {
	const createdAt = new Date(generation.created_at);
	if (Number.isNaN(createdAt.getTime())) return t`Version`;
	return format(createdAt, "HH:mm");
}

function VersionStrip({
	generations,
	selectedGenerationId,
	onSelect,
	onBackToLive,
}: {
	generations: CanvasGeneration[];
	selectedGenerationId: string | null;
	onSelect: (id: string) => void;
	onBackToLive: () => void;
}) {
	if (generations.length === 0) return null;
	const selected = generations.find((generation) => generation.id === selectedGenerationId);
	return (
		<Stack gap="xs" {...testId("canvas-version-strip")}>
			<Group gap="xs" align="center">
				<Text size="sm" fw={600}>
					<Trans>Versions</Trans>
				</Text>
				{selected ? (
					<Button size="xs" variant="subtle" onClick={onBackToLive}>
						<Trans>Viewing {generationLabel(selected)}. Back to live</Trans>
					</Button>
				) : (
					<Text size="sm">
						<Trans>Live</Trans>
					</Text>
				)}
			</Group>
			<Group gap="xs">
				{generations.map((generation) => (
					<Button
						key={generation.id}
						size="xs"
						variant={selectedGenerationId === generation.id ? "outline" : "subtle"}
						onClick={() => onSelect(generation.id)}
						{...testId(`canvas-version-${generation.id}`)}
					>
						{generationLabel(generation)}
						{generation.status === "no_op" ? ` ${t`No change`}` : ""}
						{generation.status === "error" ? ` ${t`Error`}` : ""}
					</Button>
				))}
			</Group>
		</Stack>
	);
}

export const CanvasRoute = () => {
	const { canvasId } = useParams<{ canvasId: string }>();
	const canvasQuery = useCanvas(canvasId ?? "");
	const generationsQuery = useCanvasGenerations(canvasId ?? "");
	const refreshMutation = useRefreshCanvasMutation(canvasId ?? "");
	const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(
		null,
	);
	const {
		ref: fullscreenRef,
		toggle: toggleFullscreen,
		fullscreen,
	} = useFullscreen();

	const canvas = canvasQuery.data;
	useDocumentTitle(canvas?.name ? `${canvas.name} | dembrane` : t`Canvas`);

	const generations = generationsQuery.data ?? [];
	const selectedGeneration = useMemo(
		() =>
			selectedGenerationId
				? generations.find((generation) => generation.id === selectedGenerationId)
				: null,
		[generations, selectedGenerationId],
	);
	const displayedGeneration =
		selectedGeneration ?? canvas?.latest_generation ?? generations[0] ?? null;
	const refreshDisabled =
		refreshMutation.isPending || canvas?.isDevFixture || !canvasId;

	if (canvasQuery.isLoading) {
		return (
			<PageContainer width="xl">
				<Group justify="center" py="xl">
					<Loader />
				</Group>
			</PageContainer>
		);
	}

	return (
		<PageContainer width="full" density="tight">
			<Stack gap="md" maw={1440}>
				<Group justify="space-between" align="flex-start" gap="md">
					<Stack gap={4}>
						<Title order={2} fw={500}>
							{canvas?.name ?? t`Canvas`}
						</Title>
						<Text size="sm">
							{loopStatusLine(canvas?.loop?.status, canvas?.loop?.expires_at)}
							{canvas?.isDevFixture ? ` ${t`Using fixture data.`}` : ""}
						</Text>
					</Stack>
					<Group gap="xs">
						<Tooltip
							label={
								canvas?.isDevFixture
									? t`Refresh will work when the canvas service is ready`
									: t`Ask for the latest version`
							}
							withArrow
						>
							<Button
								variant="subtle"
								leftSection={<RefreshCw size={16} />}
								disabled={refreshDisabled}
								loading={refreshMutation.isPending}
								onClick={() => refreshMutation.mutate()}
								{...testId("canvas-refresh-button")}
							>
								<Trans>Refresh now</Trans>
							</Button>
						</Tooltip>
						<Tooltip
							label={fullscreen ? t`Exit fullscreen` : t`Fullscreen`}
							withArrow
						>
							<ActionIcon
								variant="subtle"
								size="lg"
								onClick={toggleFullscreen}
								aria-label={fullscreen ? t`Exit fullscreen` : t`Fullscreen`}
								{...testId("canvas-fullscreen-button")}
							>
								{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
							</ActionIcon>
						</Tooltip>
					</Group>
				</Group>

				<Box
					ref={fullscreenRef}
					className="rounded-md bg-parchment"
					style={{
						height: fullscreen ? "100vh" : undefined,
						overflow: fullscreen ? "auto" : undefined,
						padding: fullscreen ? "24px" : undefined,
					}}
					{...testId("canvas-frame-container")}
				>
					<CanvasFrame
						generation={displayedGeneration}
						cadenceMinutes={canvas?.loop?.cadence_minutes}
					/>
				</Box>

				<VersionStrip
					generations={generations}
					selectedGenerationId={selectedGenerationId}
					onSelect={setSelectedGenerationId}
					onBackToLive={() => setSelectedGenerationId(null)}
				/>
			</Stack>
		</PageContainer>
	);
};
