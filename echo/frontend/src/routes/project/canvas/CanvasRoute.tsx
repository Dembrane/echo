import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	Paper,
	Skeleton,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDocumentTitle, useFullscreen } from "@mantine/hooks";
import { format } from "date-fns";
import { Maximize2, MessageCircle, Minimize2, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { CanvasFrame } from "@/components/canvas/CanvasFrame";
import {
	type CanvasGeneration,
	useCanvas,
	useCanvasGenerations,
	useCanvasLifecycleMutation,
	useRefreshCanvasMutation,
} from "@/components/canvas/hooks";
import { PageContainer } from "@/components/layout/PageContainer";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
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
	return t`Stays up to date until ${format(expiry, "HH:mm")}`;
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
	const selected = generations.find(
		(generation) => generation.id === selectedGenerationId,
	);
	return (
		<Paper
			withBorder
			className="rounded-md px-3 py-3"
			{...testId("canvas-version-strip")}
		>
			<Stack gap="xs">
				<Group gap="xs" align="center" justify="space-between">
					<Group gap="xs" align="center">
						<Text size="sm" fw={600}>
							<Trans>Versions</Trans>
						</Text>
						{selected ? (
							<Badge size="sm" variant="outline">
								<Trans>Viewing {generationLabel(selected)}</Trans>
							</Badge>
						) : (
							<Badge size="sm" variant="outline">
								<Trans>Live</Trans>
							</Badge>
						)}
					</Group>
					{selected ? (
						<Button size="xs" variant="subtle" onClick={onBackToLive}>
							<Trans>Back to live</Trans>
						</Button>
					) : null}
				</Group>
				<Group gap="xs" wrap="wrap">
					{generations.map((generation) => (
						<Button
							key={generation.id}
							size="xs"
							variant={
								selectedGenerationId === generation.id ? "outline" : "subtle"
							}
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
		</Paper>
	);
}

function CanvasLoadingState() {
	return (
		<PageContainer width="full" density="tight">
			<Stack gap="md" maw={1440}>
				<Group justify="space-between" align="flex-start" gap="md">
					<Stack gap="xs">
						<Skeleton height={32} width={280} />
						<Skeleton height={16} width={220} />
					</Stack>
					<Group gap="xs">
						<Skeleton height={36} width={96} radius="md" />
						<Skeleton height={36} width={128} radius="md" />
						<Skeleton height={36} width={36} radius="md" />
					</Group>
				</Group>
				<Skeleton height={520} radius="md" />
			</Stack>
		</PageContainer>
	);
}

export const CanvasRoute = () => {
	const { canvasId, workspaceId } = useParams<{
		canvasId: string;
		workspaceId: string;
	}>();
	const navigate = useI18nNavigate();
	const canvasQuery = useCanvas(canvasId ?? "");
	const generationsQuery = useCanvasGenerations(canvasId ?? "");
	const refreshMutation = useRefreshCanvasMutation(canvasId ?? "");
	const lifecycleMutation = useCanvasLifecycleMutation(canvasId ?? "");
	const [selectedGenerationId, setSelectedGenerationId] = useState<
		string | null
	>(null);
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
				? generations.find(
						(generation) => generation.id === selectedGenerationId,
					)
				: null,
		[generations, selectedGenerationId],
	);
	const displayedGeneration =
		selectedGeneration ?? canvas?.latest_generation ?? generations[0] ?? null;
	const refreshDisabled =
		refreshMutation.isPending || canvas?.isDevFixture || !canvasId;
	const loopStatus = canvas?.loop?.status;
	const isLoopActive = loopStatus === "active";
	const lifecycleDisabled =
		lifecycleMutation.isPending || canvas?.isDevFixture || !canvasId;
	const projectId = canvas?.project_id;
	const chatBasePath =
		workspaceId && projectId
			? `/w/${workspaceId}/projects/${projectId}/chats`
			: null;
	const openChatPath =
		chatBasePath && canvas?.created_from_chat_id
			? `${chatBasePath}/${canvas.created_from_chat_id}`
			: null;
	const newChatMessage = canvas?.name
		? t`Let's talk about the canvas "${canvas.name}".`
		: t`Let's talk about this canvas.`;

	if (canvasQuery.isLoading) {
		return <CanvasLoadingState />;
	}

	return (
		<PageContainer width="full" density="tight">
			<Stack gap="md" maw={1440}>
				<Group justify="space-between" align="flex-start" gap="lg">
					<Stack gap="xs" className="min-w-0">
						<Title order={2} fw={500}>
							{canvas?.name ?? t`Canvas`}
						</Title>
						<Group gap="xs" wrap="wrap">
							<Badge size="sm" variant="outline">
								{loopStatusLine(canvas?.loop?.status, canvas?.loop?.expires_at)}
							</Badge>
							{canvas?.isDevFixture ? (
								<Text size="xs">
									<Trans>Using fixture data.</Trans>
								</Text>
							) : null}
						</Group>
					</Stack>
					<Group gap="xs" justify="flex-end">
						{openChatPath ? (
							<Button
								variant="subtle"
								leftSection={<MessageCircle size={16} />}
								onClick={() => navigate(openChatPath)}
								{...testId("canvas-open-chat-button")}
							>
								<Trans>Open the chat</Trans>
							</Button>
						) : null}
						{chatBasePath ? (
							<Button
								variant="subtle"
								leftSection={<MessageCircle size={16} />}
								onClick={() =>
									navigate(`${chatBasePath}/new`, {
										state: { initialMessage: newChatMessage },
									})
								}
								{...testId("canvas-new-chat-button")}
							>
								<Trans>New chat about this canvas</Trans>
							</Button>
						) : null}
						{canvas?.loop ? (
							<Tooltip
								label={
									canvas?.isDevFixture
										? t`Loop controls will work when the canvas service is ready`
										: isLoopActive
											? t`Pause updates`
											: t`Resume updates`
								}
								withArrow
							>
								<Button
									variant="subtle"
									disabled={lifecycleDisabled}
									loading={lifecycleMutation.isPending}
									onClick={() =>
										lifecycleMutation.mutate(isLoopActive ? "pause" : "resume")
									}
									{...testId("canvas-lifecycle-button")}
								>
									{isLoopActive ? <Trans>Pause</Trans> : <Trans>Resume</Trans>}
								</Button>
							</Tooltip>
						) : null}
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
								radius="md"
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
					className="rounded-md"
					style={{
						backgroundColor: "var(--app-background)",
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
