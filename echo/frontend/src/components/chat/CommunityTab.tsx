import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Group,
	ScrollArea,
	Select,
	Stack,
	Text,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useState } from "react";
import { CommunityTemplateCard } from "./CommunityTemplateCard";
import {
	useCommunityTemplates,
	useCopyTemplate,
	useMyCommunityStars,
	useToggleStar,
} from "./hooks/useCommunityTemplates";

const ALLOWED_TAGS = [
	"Workshop",
	"Interview",
	"Focus Group",
	"Meeting",
	"Research",
	"Community",
	"Education",
	"Analysis",
];

const getSortOptions = () => [
	{ value: "newest", label: t`Newest` },
	{ value: "most_starred", label: t`Most popular` },
	{ value: "most_used", label: t`Most used` },
];

type CommunityTabProps = {
	searchQuery: string;
};

export const CommunityTab = ({ searchQuery }: CommunityTabProps) => {
	const [selectedTag, setSelectedTag] = useState<string | null>(null);
	const [sortBy, setSortBy] = useState<string>("newest");
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const sortOptions = getSortOptions();

	const [debouncedSearch] = useDebouncedValue(searchQuery, 300);

	const communityQuery = useCommunityTemplates({
		search: debouncedSearch || undefined,
		tag: selectedTag ?? undefined,
		sort: sortBy as "newest" | "most_starred" | "most_used",
	});

	const starsQuery = useMyCommunityStars();
	const toggleStarMutation = useToggleStar();
	const copyMutation = useCopyTemplate();

	const starredIds = starsQuery.data ?? new Set<string>();
	const templates = communityQuery.data ?? [];

	return (
		<Stack gap="sm" className="h-full">
			{/* Filters row */}
			<Group gap="xs">
				<ScrollArea type="never" className="flex-1">
					<Group gap={4} wrap="nowrap">
						<Badge
							size="sm"
							variant={selectedTag === null ? "filled" : "light"}
							color={selectedTag === null ? "blue" : "gray"}
							className="cursor-pointer"
							onClick={() => setSelectedTag(null)}
						>
							<Trans>All</Trans>
						</Badge>
						{ALLOWED_TAGS.map((tag) => (
							<Badge
								key={tag}
								size="sm"
								variant={selectedTag === tag ? "filled" : "light"}
								color={selectedTag === tag ? "blue" : "gray"}
								className="cursor-pointer whitespace-nowrap"
								onClick={() =>
									setSelectedTag(selectedTag === tag ? null : tag)
								}
							>
								{tag}
							</Badge>
						))}
					</Group>
				</ScrollArea>
				<Select
					size="xs"
					data={sortOptions}
					value={sortBy}
					onChange={(v) => setSortBy(v ?? "newest")}
					className="w-36"
					comboboxProps={{ withinPortal: true }}
				/>
			</Group>

			{/* Template list */}
			<ScrollArea className="flex-1" type="auto" scrollbarSize={10} offsetScrollbars>
				<Stack gap="md">
					{communityQuery.isLoading && (
						<Text size="sm" c="dimmed" ta="center" py="lg">
							<Trans>Loading...</Trans>
						</Text>
					)}

					{!communityQuery.isLoading && templates.length === 0 && (
						<Text size="sm" c="dimmed" ta="center" py="lg">
							<Trans>
								No community templates yet. Share yours to get started.
							</Trans>
						</Text>
					)}

					{templates.map((template) => (
						<CommunityTemplateCard
							key={template.id}
							template={template}
							isStarred={starredIds.has(template.id)}
							isExpanded={expandedId === template.id}
							onToggleExpand={() =>
								setExpandedId(
									expandedId === template.id ? null : template.id,
								)
							}
							onStar={() => toggleStarMutation.mutate(template.id)}
							onCopy={() => copyMutation.mutate(template.id)}
							isCopying={
								copyMutation.isPending &&
								copyMutation.variables === template.id
							}
						/>
					))}
				</Stack>
			</ScrollArea>
		</Stack>
	);
};
