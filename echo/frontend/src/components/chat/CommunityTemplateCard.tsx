import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Button,
	Collapse,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { Star, Users, Copy } from "@phosphor-icons/react";

type CommunityTemplateCardProps = {
	template: {
		id: string;
		title: string;
		description: string | null;
		content: string;
		tags: string[] | null;
		language: string | null;
		author_display_name: string | null;
		star_count: number;
		use_count: number;
		is_own: boolean;
	};
	isStarred: boolean;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onStar: () => void;
	onCopy: () => void;
	isCopying?: boolean;
};

export const CommunityTemplateCard = ({
	template,
	isStarred,
	isExpanded,
	onToggleExpand,
	onStar,
	onCopy,
	isCopying = false,
}: CommunityTemplateCardProps) => {
	return (
		<Paper
			p="md"
			withBorder
			className={`cursor-pointer transition-all ${
				isExpanded
					? "border-blue-300 bg-blue-50/30"
					: "hover:border-gray-300 hover:bg-gray-50"
			}`}
			onClick={onToggleExpand}
		>
			<Stack gap="xs">
				<Group justify="space-between" wrap="nowrap">
					<Stack gap={2} className="flex-1 min-w-0">
						<Text size="md" truncate>
							{template.title}
						</Text>
						{template.description && (
							<Text size="xs" c="dimmed" lineClamp={2}>
								{template.description}
							</Text>
						)}
					</Stack>
					<Group gap={4} wrap="nowrap">
						<Tooltip
							label={
								isStarred
									? t`Remove from favorites`
									: t`Add to favorites`
							}
						>
							<ActionIcon
								size="sm"
								variant={isStarred ? "filled" : "subtle"}
								color={isStarred ? "yellow" : "gray"}
								aria-label={
									isStarred
										? t`Remove from favorites`
										: t`Add to favorites`
								}
								onClick={(e) => {
									e.stopPropagation();
									onStar();
								}}
							>
								<Star
									size={14}
									weight={isStarred ? "fill" : "regular"}
								/>
							</ActionIcon>
						</Tooltip>
					</Group>
				</Group>

				{/* Tags + stats row */}
				<Group gap="xs">
					{template.tags?.map((tag) => (
						<Badge key={tag} size="xs" variant="light" color="gray">
							{tag}
						</Badge>
					))}
					{template.star_count > 0 && (
						<Group gap={2}>
							<Star size={12} weight="fill" color="var(--mantine-color-yellow-6)" />
							<Text size="xs" c="dimmed">
								{template.star_count}
							</Text>
						</Group>
					)}
					{template.use_count > 0 && (
						<Group gap={2}>
							<Users size={12} />
							<Text size="xs" c="dimmed">
								{template.use_count}
							</Text>
						</Group>
					)}
					<Text size="xs" c="dimmed">
						{template.author_display_name ?? t`Anonymous host`}
					</Text>
					{template.is_own && (
						<Badge size="xs" variant="light" color="blue">
							<Trans>Yours</Trans>
						</Badge>
					)}
				</Group>

				{/* Expanded preview */}
				<Collapse in={isExpanded}>
					<Stack gap="sm" pt="xs">
						<Paper p="sm" bg="gray.0" radius="sm">
							<Text size="sm" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
								{template.content}
							</Text>
						</Paper>
						<Group justify="flex-end">
							<Button
								size="xs"
								leftSection={<Copy size={14} />}
								onClick={(e) => {
									e.stopPropagation();
									onCopy();
								}}
								loading={isCopying}
							>
								<Trans>Save</Trans>
							</Button>
						</Group>
					</Stack>
				</Collapse>
			</Stack>
		</Paper>
	);
};
