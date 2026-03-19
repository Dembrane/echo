import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { formatDistance } from "date-fns";
import { testId } from "@/lib/testUtils";

const SIGNPOST_CATEGORY_ORDER: Array<
	NonNullable<ConversationSignpost["category"]>
> = ["agreement", "disagreement", "tension", "theme"];

const getCategoryColor = (category: ConversationSignpost["category"]) => {
	switch (category) {
		case "agreement":
			return "teal";
		case "disagreement":
			return "red";
		case "tension":
			return "orange";
		case "theme":
		default:
			return "blue";
	}
};

const getCategoryLabel = (category: ConversationSignpost["category"]) => {
	switch (category) {
		case "agreement":
			return t`Agreement`;
		case "disagreement":
			return t`Disagreement`;
		case "tension":
			return t`Tension`;
		case "theme":
		default:
			return t`Theme`;
	}
};

const getUpdatedLabel = (updatedAt: string | null) => {
	if (!updatedAt) {
		return t`Updated just now`;
	}

	const date = new Date(updatedAt);
	if (Number.isNaN(date.getTime())) {
		return t`Updated just now`;
	}

	return t`Updated ${formatDistance(date, new Date(), { addSuffix: true })}`;
};

type ConversationSignpostsSectionProps = {
	signposts: ConversationSignpost[];
};

export const ConversationSignpostsSection = ({
	signposts,
}: ConversationSignpostsSectionProps) => {
	const activeSignposts = signposts.filter((signpost) => signpost.status === "active");

	if (activeSignposts.length === 0) {
		return null;
	}

	return (
		<Stack gap="1.5rem" {...testId("conversation-signposts-section")}>
			<Stack gap="xs">
				<Title order={2}>
					<Trans>Signposts</Trans>
				</Title>
				<Text size="sm" c="dimmed">
					<Trans>
						Live themes, agreements, disagreements, and tensions surfaced
						from the latest transcript chunks.
					</Trans>
				</Text>
			</Stack>

			{SIGNPOST_CATEGORY_ORDER.map((category) => {
				const items = activeSignposts
					.filter((signpost) => signpost.category === category)
					.sort((left, right) => {
						const leftTime = new Date(
							left.updated_at ?? left.created_at ?? 0,
						).getTime();
						const rightTime = new Date(
							right.updated_at ?? right.created_at ?? 0,
						).getTime();
						return rightTime - leftTime;
					});

				if (items.length === 0) {
					return null;
				}

				return (
					<Stack
						key={category}
						gap="sm"
						{...testId(`conversation-signposts-group-${category}`)}
					>
						<Group gap="sm">
							<Badge
								color={getCategoryColor(category)}
								variant="light"
								size="lg"
								style={{ textTransform: "none" }}
							>
								{getCategoryLabel(category)}
							</Badge>
							<Text size="sm" c="dimmed">
								{t`${items.length} live`}
							</Text>
						</Group>

						{items.map((signpost) => (
							<Paper
								key={signpost.id}
								withBorder
								p="md"
								radius="md"
								bg="var(--mantine-color-body)"
								{...testId(`conversation-signpost-card-${signpost.id}`)}
							>
								<Stack gap="xs">
									<Group justify="space-between" gap="sm" align="flex-start">
										<Text fw={600}>{signpost.title}</Text>
										<Text size="xs" c="dimmed">
											{getUpdatedLabel(signpost.updated_at)}
										</Text>
									</Group>
									{signpost.summary && (
										<Text size="sm">{signpost.summary}</Text>
									)}
									{signpost.evidence_quote && (
										<Text size="sm" c="dimmed" fs="italic">
											"{signpost.evidence_quote}"
										</Text>
									)}
								</Stack>
							</Paper>
						))}
					</Stack>
				);
			})}
		</Stack>
	);
};
