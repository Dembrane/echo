import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	Menu,
	NumberInput,
	Paper,
	Popover,
	Select,
	Skeleton,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDocumentTitle, useFullscreen } from "@mantine/hooks";
import {
	addDays,
	addHours,
	format,
	formatDistanceToNow,
	isSameDay,
} from "date-fns";
import {
	Maximize2,
	MessageCircle,
	Minimize2,
	MoreHorizontal,
	Pause,
	Pencil,
	Play,
	RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { CanvasFrame } from "@/components/canvas/CanvasFrame";
import { canvasCadenceLabel } from "@/components/canvas/cadenceLabel";
import {
	type CanvasGeneration,
	type CanvasLoop,
	useCanvas,
	useCanvasGenerations,
	useInvalidateCanvasQueries,
	useCanvasLifecycleMutation,
	useCanvasLoopSettingsMutation,
	useRefreshCanvasMutation,
} from "@/components/canvas/hooks";
import { API_BASE_URL } from "@/config";
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
	const now = new Date();
	if (isSameDay(expiry, now)) {
		return t`Stays up to date until ${format(expiry, "HH:mm")}`;
	}
	if (isSameDay(expiry, addDays(now, 1))) {
		return t`Stays up to date until tomorrow ${format(expiry, "HH:mm")}`;
	}
	return t`Stays up to date until ${format(expiry, "EEE MMM d, HH:mm")}`;
}

function relativeTime(value?: string | null): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return formatDistanceToNow(date, { addSuffix: true });
}

function freshnessLine({
	generation,
	loop,
}: {
	generation?: CanvasGeneration | null;
	loop?: CanvasLoop | null;
}): string {
	const updatedAgo = relativeTime(generation?.created_at);
	const checkedAgo = relativeTime(loop?.last_run_started_at);
	const status = loop?.status;
	if (!loop) {
		return updatedAgo
			? t`Does not update on its own. Updated ${updatedAgo}.`
			: t`Does not update on its own.`;
	}
	if (status === "paused") {
		return updatedAgo ? t`Paused. Updated ${updatedAgo}.` : t`Paused.`;
	}
	if (status === "expired" || status === "ended" || status === "stopped") {
		const expiry = loop?.expires_at ? new Date(loop.expires_at) : null;
		const stoppedAt =
			expiry && !Number.isNaN(expiry.getTime())
				? format(expiry, "EEE MMM d, HH:mm")
				: null;
		if (updatedAgo && stoppedAt) {
			return t`Stopped on ${stoppedAt}. Updated ${updatedAgo}.`;
		}
		if (stoppedAt) return t`Stopped on ${stoppedAt}.`;
		return updatedAgo ? t`Stopped. Updated ${updatedAgo}.` : t`Stopped.`;
	}
	if (!generation) {
		return checkedAgo
			? t`Checked ${checkedAgo}. A first update will appear when there is enough to show.`
			: t`Preparing the first update.`;
	}
	if (loop?.last_run_status === "no_op" && checkedAgo && updatedAgo) {
		return t`Checked ${checkedAgo}. Nothing new since your last conversation. Updated ${updatedAgo}.`;
	}
	if (updatedAgo) return t`Updated ${updatedAgo}.`;
	return t`Updated.`;
}

function toDatetimeLocalValue(date: Date): string {
	return format(date, "yyyy-MM-dd'T'HH:mm");
}

function fromDatetimeLocalValue(value: string): Date | null {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function generationLabel(generation: CanvasGeneration): string {
	const createdAt = new Date(generation.created_at);
	if (Number.isNaN(createdAt.getTime())) return t`Version`;
	return format(createdAt, "HH:mm");
}

function CanvasLoopSettings({
	canvasId,
	disabled,
	loop,
	onSaved,
}: {
	canvasId: string;
	disabled?: boolean;
	loop?: CanvasLoop | null;
	onSaved?: () => void;
}) {
	const [duration, setDuration] = useState("24h");
	const [customHours, setCustomHours] = useState(24);
	const [customExpiry, setCustomExpiry] = useState(
		toDatetimeLocalValue(addHours(new Date(), 24)),
	);
	const [cadence, setCadence] = useState(String(loop?.cadence_minutes ?? 5));
	const mutation = useCanvasLoopSettingsMutation(canvasId);

	useEffect(() => {
		setCadence(String(loop?.cadence_minutes ?? 5));
		if (!loop?.expires_at) return;
		const expiry = new Date(loop.expires_at);
		if (!Number.isNaN(expiry.getTime())) {
			setCustomExpiry(toDatetimeLocalValue(expiry));
		}
	}, [loop?.cadence_minutes, loop?.expires_at]);

	const cadenceText = loop ? canvasCadenceLabel(loop) : null;
	const canEdit =
		!!loop &&
		!disabled &&
		!["expired", "ended", "stopped"].includes(loop.status);

	const nextExpiry = () => {
		const now = new Date();
		if (duration === "8h") return addHours(now, 8);
		if (duration === "24h") return addHours(now, 24);
		if (duration === "3d") return addDays(now, 3);
		return fromDatetimeLocalValue(customExpiry) ?? addHours(now, customHours);
	};

	const save = () => {
		mutation.mutate(
			{
				cadence_minutes: Number(cadence),
				expires_at: nextExpiry().toISOString(),
			},
			{ onSuccess: onSaved },
		);
	};

	return (
		<Stack gap="sm" w={300} p="xs">
			<Stack gap={2}>
				<Text size="sm" fw={600}>
					<Trans>Keep this canvas fresh</Trans>
				</Text>
				{cadenceText ? <Text size="xs">{cadenceText}</Text> : null}
			</Stack>
			<Select
				label={t`Stay live for`}
				value={duration}
				disabled={!canEdit}
				onChange={(value) => setDuration(value ?? "24h")}
				data={[
					{ label: t`8 hours`, value: "8h" },
					{ label: t`24 hours`, value: "24h" },
					{ label: t`3 days`, value: "3d" },
					{ label: t`Custom`, value: "custom" },
				]}
			/>
			{duration === "custom" ? (
				<>
					<NumberInput
						label={t`Hours from now`}
						min={1}
						max={168}
						value={customHours}
						disabled={!canEdit}
						onChange={(value) => setCustomHours(Number(value) || 24)}
					/>
					<TextInput
						label={t`Or choose a time`}
						type="datetime-local"
						value={customExpiry}
						disabled={!canEdit}
						onChange={(event) => setCustomExpiry(event.currentTarget.value)}
					/>
				</>
			) : null}
			<Select
				label={t`Update rhythm`}
				value={cadence}
				disabled={!canEdit}
				onChange={(value) => setCadence(value ?? "5")}
				data={[
					{ label: t`Every 5 minutes`, value: "5" },
					{ label: t`Every 15 minutes`, value: "15" },
					{ label: t`Every 60 minutes`, value: "60" },
				]}
			/>
			<Button
				onClick={save}
				loading={mutation.isPending}
				disabled={!canEdit}
				{...testId("canvas-freshness-save-button")}
			>
				<Trans>Save</Trans>
			</Button>
		</Stack>
	);
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
	const invalidateCanvasQueries = useInvalidateCanvasQueries(canvasId ?? "");
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
	const [menuOpened, setMenuOpened] = useState(false);
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
	const primaryChatPath =
		openChatPath ?? (chatBasePath ? `${chatBasePath}/new` : null);
	const openPrimaryChat = () => {
		if (!primaryChatPath) return;
		if (openChatPath) {
			navigate(openChatPath);
			return;
		}
		navigate(primaryChatPath, { state: { initialMessage: newChatMessage } });
	};
	const [settingsOpened, setSettingsOpened] = useState(false);
	const freshnessText =
		generationsQuery.isLoading && !displayedGeneration
			? null
			: freshnessLine({
					generation: displayedGeneration,
					loop: canvas?.loop,
				});

	useEffect(() => {
		if (!canvasId || canvas?.isDevFixture) return;
		let source: EventSource | null = null;
		let reconnectTimer: number | null = null;
		let retryMs = 1000;
		let closed = false;

		const connect = () => {
			if (closed) return;
			const url = `${API_BASE_URL}/v2/bff/canvases/${encodeURIComponent(
				canvasId,
			)}/events`;
			source = new EventSource(url, { withCredentials: true });
			source.addEventListener("connected", () => {
				retryMs = 1000;
			});
			source.addEventListener("generation", () => {
				retryMs = 1000;
				invalidateCanvasQueries();
			});
			source.onerror = () => {
				source?.close();
				source = null;
				if (closed) return;
				reconnectTimer = window.setTimeout(connect, retryMs);
				retryMs = Math.min(retryMs * 2, 30000);
			};
		};

		connect();
		return () => {
			closed = true;
			source?.close();
			if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
		};
	}, [canvas?.isDevFixture, canvasId, invalidateCanvasQueries]);

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
						<Group gap="xs" wrap="wrap" {...testId("canvas-freshness-cluster")}>
							{canvas?.loop ? (
								<Badge size="sm" variant="outline" tt="none">
									{loopStatusLine(canvas.loop.status, canvas.loop.expires_at)}
								</Badge>
							) : null}
							{freshnessText ? <Text size="sm">{freshnessText}</Text> : null}
							{canvasId && canvas?.loop ? (
								<Popover
									opened={settingsOpened}
									onChange={setSettingsOpened}
									position="bottom-start"
									shadow="md"
									width={340}
									withinPortal
								>
									<Popover.Target>
										<Tooltip label={t`Edit freshness settings`} withArrow>
											<ActionIcon
												variant="subtle"
												size="sm"
												radius="md"
												aria-label={t`Edit freshness settings`}
												disabled={canvas?.isDevFixture}
												onClick={() => setSettingsOpened((opened) => !opened)}
												{...testId("canvas-freshness-settings-button")}
											>
												<Pencil size={14} />
											</ActionIcon>
										</Tooltip>
									</Popover.Target>
									<Popover.Dropdown>
										<CanvasLoopSettings
											canvasId={canvasId}
											disabled={canvas?.isDevFixture}
											loop={canvas.loop}
											onSaved={() => setSettingsOpened(false)}
										/>
									</Popover.Dropdown>
								</Popover>
							) : null}
							{canvas?.isDevFixture ? (
								<Text size="sm">
									<Trans>Using fixture data.</Trans>
								</Text>
							) : null}
						</Group>
					</Stack>
					<Group gap="xs" justify="flex-end">
						{primaryChatPath ? (
							<Button
								leftSection={<MessageCircle size={16} />}
								onClick={openPrimaryChat}
								{...testId(
									openChatPath
										? "canvas-open-chat-button"
										: "canvas-new-chat-button",
								)}
							>
								{openChatPath ? (
									<Trans>Open the chat</Trans>
								) : (
									<Trans>New chat about this canvas</Trans>
								)}
							</Button>
						) : null}
						<Tooltip
							label={fullscreen ? t`Exit fullscreen` : t`Full screen`}
							withArrow
						>
							<ActionIcon
								variant="subtle"
								size="lg"
								radius="md"
								aria-label={fullscreen ? t`Exit fullscreen` : t`Full screen`}
								onClick={toggleFullscreen}
								{...testId("canvas-fullscreen-button")}
							>
								{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
							</ActionIcon>
						</Tooltip>
						<Menu
							opened={menuOpened}
							onChange={setMenuOpened}
							position="bottom-end"
							shadow="md"
							width={260}
						>
							<Menu.Target>
								<ActionIcon
									variant="subtle"
									size="lg"
									radius="md"
									aria-label={t`Canvas settings`}
									{...testId("canvas-actions-menu-button")}
								>
									<MoreHorizontal size={18} />
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown>
								{openChatPath && chatBasePath ? (
									<Menu.Item
										leftSection={<MessageCircle size={16} />}
										onClick={() => {
											setMenuOpened(false);
											navigate(`${chatBasePath}/new`, {
												state: { initialMessage: newChatMessage },
											});
										}}
									>
										<Trans>New chat about this canvas</Trans>
									</Menu.Item>
								) : null}
								{canvas?.loop ? (
									<Menu.Item
										leftSection={
											isLoopActive ? <Pause size={16} /> : <Play size={16} />
										}
										disabled={lifecycleDisabled}
										onClick={() => {
											lifecycleMutation.mutate(
												isLoopActive ? "pause" : "resume",
											);
											setMenuOpened(false);
										}}
										{...testId("canvas-lifecycle-button")}
									>
										{isLoopActive ? (
											<Trans>Pause updates</Trans>
										) : (
											<Trans>Resume updates</Trans>
										)}
									</Menu.Item>
								) : null}
								<Menu.Item
									leftSection={<RefreshCw size={16} />}
									disabled={refreshDisabled}
									onClick={() => {
										refreshMutation.mutate();
										setMenuOpened(false);
									}}
									{...testId("canvas-refresh-button")}
								>
									<Trans>Refresh now</Trans>
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					</Group>
				</Group>

				<Box
					ref={fullscreenRef}
					className="rounded-md"
					style={{
						backgroundColor: "var(--app-background)",
						height: fullscreen ? "100dvh" : undefined,
						minHeight: fullscreen ? "100dvh" : undefined,
						width: fullscreen ? "100dvw" : undefined,
						overflow: fullscreen ? "hidden" : undefined,
						padding: fullscreen ? 0 : undefined,
					}}
					{...testId("canvas-frame-container")}
				>
					<CanvasFrame
						generation={displayedGeneration}
						projectId={projectId}
						fullscreen={fullscreen}
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
