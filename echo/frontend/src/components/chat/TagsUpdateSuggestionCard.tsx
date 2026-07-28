import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { SuggestionCardFrame } from "@/components/common/SuggestionCardFrame";
import { toast } from "@/components/common/Toaster";
import { createProjectTag, useProjectById } from "@/components/project/hooks";
import { deleteTagById } from "@/lib/api";
import { testId } from "@/lib/testUtils";

export type TagsUpdateSuggestion = {
	projectId: string;
	summary: string;
	add: string[];
	remove: string[];
	currentTags: string[];
};

const tagBadgeStyle = { fontWeight: 500, textTransform: "none" } as const;

const normalizeText = (text: string) => text.trim().toLowerCase();

/**
 * Renders a proposeTagsUpdate result as an in-chat card. The agent never
 * writes tags; the host applies the changes here through the same BFF tag
 * endpoints the portal editor uses, under their own session.
 *
 * Applied state is stateless: the card compares the live tag list to the
 * proposal, so a reload still shows "Applied" truthfully.
 */
export const TagsUpdateSuggestionCard = ({
	suggestion,
}: {
	suggestion: TagsUpdateSuggestion;
}) => {
	const queryClient = useQueryClient();
	const projectQuery = useProjectById({
		projectId: suggestion.projectId,
		query: {
			deep: { tags: { _sort: "sort" } },
			fields: ["id", { tags: ["id", "text", "sort"] }],
		},
	});

	const [dismissed, setDismissed] = useState(false);
	const [isApplying, setIsApplying] = useState(false);

	const liveTags = useMemo(
		() =>
			((projectQuery.data?.tags as unknown as ProjectTag[]) ?? []).filter(
				(tag): tag is ProjectTag & { text: string } => Boolean(tag?.text),
			),
		[projectQuery.data],
	);

	// Stateless applied detection: if every addition is present and every
	// removal is gone from the live tag list, this suggestion has been applied
	// (even after a reload).
	const applied = useMemo(() => {
		if (!projectQuery.data) return false;
		const liveTexts = new Set(liveTags.map((tag) => normalizeText(tag.text)));
		return (
			suggestion.add.every((text) => liveTexts.has(normalizeText(text))) &&
			suggestion.remove.every((text) => !liveTexts.has(normalizeText(text)))
		);
	}, [projectQuery.data, liveTags, suggestion.add, suggestion.remove]);

	const handleApply = async () => {
		const liveByText = new Map(
			liveTags.map((tag) => [normalizeText(tag.text), tag]),
		);
		// Partial state is fine: skip additions that already exist and
		// removals that are already gone, and apply what's applicable.
		const additions = suggestion.add.filter(
			(text) => !liveByText.has(normalizeText(text)),
		);
		const removals = suggestion.remove
			.map((text) => liveByText.get(normalizeText(text)))
			.filter(
				(tag): tag is ProjectTag & { text: string } => tag !== undefined,
			);
		const maxSort = Math.max(0, ...liveTags.map((tag) => tag.sort ?? 0));

		setIsApplying(true);
		try {
			for (const tag of removals) {
				await deleteTagById(suggestion.projectId, tag.id);
			}
			await Promise.all(
				additions.map((text, index) =>
					createProjectTag({
						projectId: suggestion.projectId,
						sort: maxSort + index + 1,
						text,
					}),
				),
			);
			toast.success(
				t`Tags updated. You can fine-tune them anytime in the portal editor.`,
			);
		} catch {
			toast.error(t`Could not apply all the tag changes.`);
		} finally {
			await queryClient.invalidateQueries({ queryKey: ["projects"] });
			await projectQuery.refetch();
			setIsApplying(false);
		}
	};

	const additionBadges = suggestion.add.map((text) => (
		<Badge key={text} color="primary" variant="light" style={tagBadgeStyle}>
			{text}
		</Badge>
	));
	const removalBadges = suggestion.remove.map((text) => (
		<Badge key={text} color="red" variant="light" style={tagBadgeStyle}>
			<span className="line-through">{text}</span>
		</Badge>
	));

	if (applied) {
		return (
			<SuggestionCardFrame compact testId="agentic-tags-update-suggestion">
				<Stack gap="xs">
					<Group gap="xs" wrap="nowrap">
						<IconCheck
							size={16}
							className="shrink-0"
							style={{ color: "var(--mantine-color-primary-7)" }}
						/>
						<Text size="sm">
							<Trans>These tag changes are applied to your project.</Trans>
						</Text>
					</Group>
					{/* Keep the record of what changed; a bare confirmation tells
					    the host nothing when they come back to the chat later. */}
					<Stack
						gap="sm"
						className="ml-6 border-l-2 pl-3"
						style={{ borderColor: "var(--mantine-color-primary-light)" }}
					>
						{suggestion.add.length > 0 && (
							<Stack gap={4}>
								<Text size="xs" fw={600}>
									<Trans>Added</Trans>
								</Text>
								<Group gap={6}>{additionBadges}</Group>
							</Stack>
						)}
						{suggestion.remove.length > 0 && (
							<Stack gap={4}>
								<Text size="xs" fw={600}>
									<Trans>Removed</Trans>
								</Text>
								<Group gap={6}>{removalBadges}</Group>
							</Stack>
						)}
					</Stack>
				</Stack>
			</SuggestionCardFrame>
		);
	}

	return (
		<SuggestionCardFrame testId="agentic-tags-update-suggestion">
			<Stack gap="sm">
				<Group justify="space-between" wrap="nowrap">
					<Text size="sm" fw={600}>
						<Trans>Suggested tag changes for your project</Trans>
					</Text>
					{dismissed && (
						<Badge size="xs" variant="outline">
							<Trans>Dismissed</Trans>
						</Badge>
					)}
				</Group>
				{suggestion.summary && <Text size="xs">{suggestion.summary}</Text>}
				{!dismissed && (
					<Text size="xs" fs="italic" c="graphite.6">
						<Trans>
							Tags are the vocabulary participants can pick from in the portal.
							Nothing changes until you apply.
						</Trans>
					</Text>
				)}

				<Stack gap="sm">
					{suggestion.add.length > 0 && (
						<Stack gap={4}>
							<Text size="xs" fw={500}>
								<Trans>Add</Trans>
							</Text>
							<Group gap={6}>{additionBadges}</Group>
						</Stack>
					)}
					{suggestion.remove.length > 0 && (
						<Stack gap={4}>
							<Text size="xs" fw={500}>
								<Trans>Remove</Trans>
							</Text>
							<Group gap={6}>{removalBadges}</Group>
						</Stack>
					)}
				</Stack>

				{!dismissed && (
					<Group justify="flex-end" gap="sm">
						<Button
							variant="subtle"
							size="xs"
							onClick={() => setDismissed(true)}
							{...testId("tags-suggestion-dismiss-button")}
						>
							<Trans>Not now</Trans>
						</Button>
						<Button
							size="xs"
							loading={isApplying}
							disabled={!projectQuery.data}
							onClick={() => void handleApply()}
							{...testId("tags-suggestion-apply-button")}
						>
							<Trans>Apply</Trans>
						</Button>
					</Group>
				)}
			</Stack>
		</SuggestionCardFrame>
	);
};
