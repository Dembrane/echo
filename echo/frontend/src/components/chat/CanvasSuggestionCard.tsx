import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Button, Group, Stack, Text } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { CanvasFrame } from "@/components/canvas/CanvasFrame";
import {
	type CanvasGeneration,
	type CanvasProposal,
	useCanvas,
	useCreateCanvasMutation,
	usePreviewCanvasMutation,
	useProjectCanvases,
	useUpdateCanvasMutation,
} from "@/components/canvas/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { SuggestionCardFrame } from "@/components/common/SuggestionCardFrame";
import { testId } from "@/lib/testUtils";

export type CanvasSuggestion = CanvasProposal;

type BffError = Error & { status?: number };

function rhythmLine(proposal: CanvasSuggestion): string {
	if (!proposal.expires_at) return t`Updates every few minutes.`;
	const expiry = new Date(proposal.expires_at);
	if (Number.isNaN(expiry.getTime())) return t`Updates every few minutes.`;
	return t`Updates every few minutes until ${format(expiry, "PPp")}.`;
}

function truncatedBrief(brief: string, expanded: boolean): string {
	const normalized = brief.trim();
	if (expanded || normalized.length <= 220) return normalized;
	return `${normalized.slice(0, 220).trim()}...`;
}

function normalizedJson(value: unknown): string {
	return JSON.stringify(value ?? null);
}

function isSameProposalConfig(
	suggestion: CanvasSuggestion,
	config:
		| {
				brief?: string | null;
				gather_spec?: Record<string, unknown> | null;
				cadence_minutes?: number | null;
				created_at?: string | null;
		  }
		| null
		| undefined,
): boolean {
	if (!config) return false;
	return (
		String(config.brief ?? "").trim() === suggestion.brief.trim() &&
		(config.cadence_minutes ?? null) === (suggestion.cadence_minutes ?? null) &&
		normalizedJson(config.gather_spec) ===
			normalizedJson(suggestion.gather_spec ?? null)
	);
}

function isAfterProposal(
	configCreatedAt: string | null | undefined,
	proposedAt: string | null | undefined,
): boolean {
	if (!configCreatedAt || !proposedAt) return false;
	const configTime = new Date(configCreatedAt).getTime();
	const proposalTime = new Date(proposedAt).getTime();
	if (Number.isNaN(configTime) || Number.isNaN(proposalTime)) return false;
	return configTime >= proposalTime;
}

function changeRows(
	suggestion: CanvasSuggestion,
	current:
		| {
				name?: string | null;
				config?: {
					brief?: string | null;
					cadence_minutes?: number | null;
				} | null;
		  }
		| null
		| undefined,
) {
	const rows: { label: string; before: string; after: string }[] = [];
	const currentName = String(
		current?.name ?? suggestion.target_canvas_name ?? "",
	);
	if (currentName && currentName !== suggestion.name) {
		rows.push({ label: t`Name`, before: currentName, after: suggestion.name });
	}
	const currentBrief = String(current?.config?.brief ?? "");
	if (currentBrief && currentBrief.trim() !== suggestion.brief.trim()) {
		rows.push({
			label: t`Brief`,
			before: currentBrief.trim(),
			after: suggestion.brief.trim(),
		});
	}
	const currentCadence = current?.config?.cadence_minutes ?? null;
	const nextCadence = suggestion.cadence_minutes ?? null;
	if (currentCadence !== null && currentCadence !== nextCadence) {
		rows.push({
			label: t`Refresh`,
			before: t`${currentCadence} min`,
			after: nextCadence ? t`${nextCadence} min` : t`Default`,
		});
	}
	return rows;
}

export const CanvasSuggestionCard = ({
	suggestion,
	chatId,
	onApplied,
}: {
	suggestion: CanvasSuggestion;
	chatId?: string | null;
	onApplied?: () => void | Promise<void>;
}) => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const previewMutation = usePreviewCanvasMutation();
	const createMutation = useCreateCanvasMutation();
	const updateMutation = useUpdateCanvasMutation();
	const canvasesQuery = useProjectCanvases(suggestion.projectId);
	const [dismissed, setDismissed] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [previewHtml, setPreviewHtml] = useState<string | null>(null);
	const [previewNotice, setPreviewNotice] = useState<string | null>(null);
	const [appliedCanvasId, setAppliedCanvasId] = useState<string | null>(null);
	const normalizedName = suggestion.name.trim().toLocaleLowerCase();
	const matchingCanvas = useMemo(
		() =>
			(canvasesQuery.data ?? []).find(
				(canvas) => canvas.name.trim().toLocaleLowerCase() === normalizedName,
			) ?? null,
		[canvasesQuery.data, normalizedName],
	);
	const targetCanvasId =
		suggestion.target_canvas_id ?? matchingCanvas?.id ?? null;
	const isUpdateProposal = Boolean(suggestion.target_canvas_id);
	const isUpdateChoice = Boolean(targetCanvasId);
	const targetCanvasQuery = useCanvas(targetCanvasId ?? "");
	const targetCanvas = targetCanvasQuery.data ?? null;
	const updateAppliedByConfig =
		isUpdateProposal &&
		targetCanvas?.id === targetCanvasId &&
		isSameProposalConfig(suggestion, targetCanvas.config) &&
		isAfterProposal(targetCanvas.config?.created_at, suggestion.proposed_at);
	const effectiveAppliedCanvasId =
		appliedCanvasId ?? (updateAppliedByConfig ? targetCanvasId : null);
	const rows = changeRows(suggestion, targetCanvas);

	const previewGeneration = useMemo<CanvasGeneration | null>(() => {
		if (!previewHtml) return null;
		return {
			config_revision_id: "preview",
			content_html: previewHtml,
			created_at: new Date().toISOString(),
			id: "canvas-proposal-preview",
			report_id: "preview",
			status: "ok",
			tick_kind: "preview",
		};
	}, [previewHtml]);

	const openPath =
		workspaceId && effectiveAppliedCanvasId
			? `/w/${workspaceId}/projects/${suggestion.projectId}/canvases/${effectiveAppliedCanvasId}`
			: null;

	const handlePreview = async () => {
		setPreviewNotice(null);
		try {
			const response = await previewMutation.mutateAsync(suggestion);
			setPreviewHtml(response.content_html);
		} catch (error) {
			const bffError = error as BffError;
			if (bffError.status === 429) {
				setPreviewNotice(t`Just previewed. Give it a moment.`);
				return;
			}
			setPreviewNotice(
				bffError.message || t`Could not preview this canvas right now.`,
			);
		}
	};

	const handleApply = async () => {
		try {
			const appliedPreview = previewHtml
				? { applied_preview_html: previewHtml }
				: {};
			if (isUpdateChoice && targetCanvasId) {
				const canvas = await updateMutation.mutateAsync({
					...suggestion,
					...appliedPreview,
					created_from_chat_id: chatId ?? null,
					target_canvas_id: targetCanvasId,
				});
				setAppliedCanvasId(canvas.id);
				await onApplied?.();
				return;
			}
			const canvas = await createMutation.mutateAsync({
				...suggestion,
				...appliedPreview,
				created_from_chat_id: chatId ?? null,
			});
			setAppliedCanvasId(canvas.id);
			await onApplied?.();
		} catch {
			// The mutation surfaces its own error toast.
		}
	};

	if (effectiveAppliedCanvasId) {
		return (
			<SuggestionCardFrame compact testId="agentic-canvas-suggestion-applied">
				<Group gap="xs" wrap="nowrap">
					<IconCheck
						size={16}
						className="shrink-0"
						style={{ color: "var(--mantine-color-primary-7)" }}
					/>
					<Text size="sm">
						<Trans>
							Applied. The canvas now shows this design and keeps it fresh.
						</Trans>{" "}
						{openPath ? (
							<I18nLink to={openPath}>
								<Trans>Open in library</Trans>
							</I18nLink>
						) : null}
					</Text>
				</Group>
			</SuggestionCardFrame>
		);
	}

	return (
		<SuggestionCardFrame testId="agentic-canvas-suggestion">
			<Stack gap="sm">
				<Group justify="space-between" wrap="nowrap">
					<Stack gap={2}>
						<Text size="sm" fw={600}>
							{suggestion.name}
						</Text>
						<Text size="xs">{rhythmLine(suggestion)}</Text>
					</Stack>
					{isUpdateChoice ? (
						<Badge size="xs" variant="light">
							<Trans>Update</Trans>
						</Badge>
					) : null}
					{dismissed ? (
						<Badge size="xs" variant="outline">
							<Trans>Dismissed</Trans>
						</Badge>
					) : null}
				</Group>

				<Text size="sm" fs="italic">
					"{truncatedBrief(suggestion.brief, expanded)}"
				</Text>
				{isUpdateChoice ? (
					<Stack gap={4}>
						<Text size="xs" fw={600}>
							<Trans>Proposed changes</Trans>
						</Text>
						{rows.length ? (
							rows.map((row) => (
								<Text key={row.label} size="xs">
									{row.label}: {truncatedBrief(row.before, false)}{" "}
									<Trans>to</Trans> {truncatedBrief(row.after, false)}
								</Text>
							))
						) : (
							<Text size="xs">
								<Trans>
									Applies this wording and refresh behavior to the existing
									canvas.
								</Trans>
							</Text>
						)}
					</Stack>
				) : null}
				{suggestion.brief.trim().length > 220 ? (
					<Button
						variant="subtle"
						size="xs"
						onClick={() => setExpanded((value) => !value)}
						className="self-start"
					>
						{expanded ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
					</Button>
				) : null}

				{previewNotice ? <Text size="xs">{previewNotice}</Text> : null}

				{previewGeneration ? (
					<Stack gap="xs" {...testId("canvas-proposal-preview")}>
						<Group gap="xs">
							<Badge variant="outline">
								<Trans>Preview</Trans>
							</Badge>
							<Text size="xs">
								<Trans>This is not saved yet.</Trans>
							</Text>
						</Group>
						<Box
							className="max-h-[560px] overflow-auto rounded-md border"
							style={{ borderColor: "var(--mantine-color-primary-light)" }}
						>
							<CanvasFrame
								generation={previewGeneration}
								projectId={suggestion.projectId}
							/>
						</Box>
					</Stack>
				) : null}

				<Group justify="flex-end" gap="xs">
					{!dismissed ? (
						<Button
							variant="subtle"
							size="xs"
							onClick={() => setDismissed(true)}
						>
							<Trans>Dismiss</Trans>
						</Button>
					) : (
						<Button
							variant="subtle"
							size="xs"
							onClick={() => setDismissed(false)}
						>
							<Trans>Review again</Trans>
						</Button>
					)}
					{!dismissed ? (
						<>
							<Button
								variant="outline"
								size="xs"
								loading={previewMutation.isPending}
								onClick={() => void handlePreview()}
								{...testId("canvas-proposal-preview-button")}
							>
								<Trans>Try it</Trans>
							</Button>
							<Button
								size="xs"
								loading={
									createMutation.isPending ||
									updateMutation.isPending ||
									canvasesQuery.isFetching ||
									targetCanvasQuery.isFetching
								}
								onClick={() => void handleApply()}
								{...testId("canvas-proposal-apply-button")}
							>
								<Trans>Apply</Trans>
							</Button>
						</>
					) : null}
				</Group>
			</Stack>
		</SuggestionCardFrame>
	);
};
