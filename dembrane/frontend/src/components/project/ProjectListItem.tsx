import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Avatar,
	Box,
	Checkbox,
	Flex,
	Group,
	Menu,
	Paper,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	CalendarBlankIcon,
	DotsThreeIcon,
	LockIcon,
	PushPinIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { formatRelative } from "date-fns";
import type { PropsWithChildren } from "react";
import { useParams } from "react-router";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { avatarUrl } from "@/lib/avatar";
import { testId } from "@/lib/testUtils";
import { formatDurationFromHours } from "@/lib/time";
import { InputModal } from "../common/InputModal";
import { I18nLink } from "../common/i18nLink";
import { useUpdateProjectByIdMutation } from "./hooks";

/**
 * Access bubbles rendered on the project list card.
 *
 * Design call (2026-04-21):
 *   - Up to 3 real avatars + a rounded `+N` overflow bubble in Royal Blue.
 *   - Single group tooltip: "Shared with Alice, Bob, Carol and 12 others".
 *   - Lives in a fixed-width slot so bubbles align down the column.
 *   - Private project with count=0 still shows a single creator placeholder
 *     so the grid doesn't get holes.
 */
function AccessBubbles({ project }: { project: Project }) {
	const preview = (
		project as unknown as {
			access_preview?: Array<{
				display_name: string;
				avatar: string | null;
			}>;
			access_count?: number;
		}
	).access_preview;
	const count =
		(project as unknown as { access_count?: number }).access_count ??
		preview?.length ??
		0;

	if (!preview) return null;
	// Empty preview for a project we got in the list — rare but render a
	// placeholder bubble so the column alignment doesn't break.
	if (preview.length === 0) {
		return (
			<Avatar
				size="sm"
				radius="xl"
				color="gray"
				aria-label={t`No one shared yet`}
			>
				?
			</Avatar>
		);
	}

	const shown = preview.slice(0, 3);
	const overflow = Math.max(0, count - shown.length);
	const visibleNames = shown.map((p) => p.display_name).filter(Boolean);
	const tooltipLabel =
		overflow > 0
			? t`Shared with ${visibleNames.join(", ")} and ${overflow} others`
			: t`Shared with ${visibleNames.join(", ")}`;

	return (
		<Tooltip label={tooltipLabel} withArrow>
			<Avatar.Group
				spacing="sm"
				role="group"
				aria-label={t`People with access`}
			>
				{shown.map((p, i) => (
					<Avatar
						key={`${p.display_name}-${i}`}
						size="sm"
						radius="xl"
						src={avatarUrl(p.avatar, 48)}
						aria-label={p.display_name || t`Unknown`}
					>
						{(p.display_name || "?").slice(0, 2).toUpperCase()}
					</Avatar>
				))}
				{overflow > 0 && (
					<Avatar
						size="sm"
						radius="xl"
						color="blue"
						aria-label={t`${overflow} more people`}
					>
						+{overflow}
					</Avatar>
				)}
			</Avatar.Group>
		</Tooltip>
	);
}

const LANGUAGE_LABELS: Record<string, string> = {
	de: "DE",
	en: "EN",
	es: "ES",
	fr: "FR",
	it: "IT",
	multi: "Multi",
	nl: "NL",
};

export const ProjectListItem = ({
	project,
	onTogglePin,
	isPinned,
	canPin,
	canEdit,
	onSearchOwner,
	selectable,
	selected,
	onToggleSelect,
}: PropsWithChildren<{
	project: Project;
	onTogglePin?: (projectId: string) => void;
	isPinned?: boolean;
	canPin?: boolean;
	/** Shows the row menu (rename, configure portal). Off for read-only roles. */
	canEdit?: boolean;
	onSearchOwner?: (term: string) => void;
	/** Select mode is active: show the inline checkbox and toggle instead of navigating. */
	selectable?: boolean;
	selected?: boolean;
	onToggleSelect?: () => void;
}>) => {
	const { workspaceId } = useParams();
	const link = `/w/${workspaceId}/projects/${project.id}/home`;
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const updateProject = useUpdateProjectByIdMutation();
	const [renameOpened, renameHandlers] = useDisclosure(false);
	const languageLabel = project.language
		? (LANGUAGE_LABELS[project.language] ?? project.language.toUpperCase())
		: null;
	const ownerName = (project as any).owner_name as string | undefined;
	const ownerEmail = (project as any).owner_email as string | undefined;

	const content = (
		<Group justify="space-between" wrap="nowrap">
			<Group wrap="nowrap" gap="sm" style={{ flex: 1, minWidth: 0 }}>
				{/* Checkbox sits inside the card's left padding so its inset
					    mirrors the pin on the right. Read-only: the whole card is
					    the click target in select mode. */}
				{selectable && (
					<Checkbox.Indicator
						checked={!!selected}
						data-testid={`project-select-${project.id}`}
					/>
				)}
				<Stack gap="0" style={{ flex: 1, minWidth: 0 }}>
					{/* A long name stays on one line: wrapping pushed the icon off
						    the baseline and squeezed the language badge to "E…". */}
					<Group align="center" gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
						<Box style={{ display: "flex", flex: "none" }}>
							<CalendarBlankIcon size={16} />
						</Box>
						<Text
							size="lg"
							truncate
							title={project.name ?? undefined}
							style={{ minWidth: 0 }}
							{...testId(`project-list-item-name-${project.id}`)}
						>
							{project.name}
						</Text>
						{/* Muted lock marks private projects on the list. */}
						{(project as unknown as { visibility?: string }).visibility ===
							"private" && (
							<Tooltip label={t`Private project`} withArrow>
								<LockIcon
									size={16}
									style={{
										color: "var(--mantine-color-dimmed)",
										flex: "none",
									}}
									aria-label={t`Private project`}
								/>
							</Tooltip>
						)}
					</Group>
					<Text size="sm" c="dimmed">
						{((project as unknown as { audio_hours?: number }).audio_hours ??
							0) > 0 && (
							<>
								{formatDurationFromHours(
									(project as unknown as { audio_hours?: number })
										.audio_hours ?? 0,
								)}
								{" · "}
							</>
						)}
						<Plural
							value={
								project.conversations_count ??
								project?.conversations?.length ??
								0
							}
							one="# conversation"
							other="# conversations"
						/>
						{/* The language sits here, not beside the name, so a long
							    name has the whole title line to itself. */}
						{languageLabel && ` · ${languageLabel}`}
						{" · "}
						<Trans>
							Edited{" "}
							{formatRelative(
								new Date(project.updated_at ?? new Date()),
								new Date(),
							)}
						</Trans>
						{(ownerName || ownerEmail) && (
							<>
								{" · "}
								{/* Show name by default; email only on hover via tooltip.
									    Matches the "don't display emails by default in lists"
									    rule from CLAUDE.md + brand style guide. Falls back to
									    email when the owner has no display_name (rare). */}
								<Tooltip label={ownerEmail} disabled={!ownerEmail}>
									<Text
										size="sm"
										c="dimmed"
										component="span"
										className="cursor-pointer hover:underline"
										onClick={(e: React.MouseEvent) => {
											e.preventDefault();
											e.stopPropagation();
											onSearchOwner?.(ownerEmail ?? ownerName ?? "");
										}}
									>
										{ownerName || t`Unknown`}
									</Text>
								</Tooltip>
							</>
						)}
					</Text>
				</Stack>
			</Group>

			{/* Access bubbles — dedicated slot directly left of the pin.
					    Fixed min-width keeps them aligned down the column so rows
					    scan cleanly. See design-subagent decision 2026-04-21.
					    On a phone the people, pin and menu stack in a column at the
					    right edge, so the name keeps the width of the row. */}
			<Flex
				direction={{ base: "column-reverse", sm: "row" }}
				gap={{ base: 4, sm: "md" }}
				wrap="nowrap"
				align={{ base: "flex-end", sm: "center" }}
			>
				<Box
					style={{
						display: "flex",
						justifyContent: "flex-end",
						minWidth: 96,
					}}
				>
					<AccessBubbles project={project} />
				</Box>
				{/* Pin and menu read as one cluster: the space between them
					    stays smaller than the space from the menu to the card edge. */}
				<Group gap={0} mr={4} wrap="nowrap" align="center">
					{/* In select mode the row is a checkbox; a pin inside it would nest a button. */}
					{onTogglePin && !selectable && (
						<Tooltip
							label={
								isPinned
									? t`Unpin project`
									: canPin
										? t`Pin project`
										: t`Unpin a project first (max 3)`
							}
						>
							<ActionIcon
								aria-label={isPinned ? t`Unpin project` : t`Pin project`}
								variant="subtle"
								color={isPinned ? "primary" : "gray"}
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									if (isPinned || canPin) {
										onTogglePin(project.id);
									}
								}}
							>
								<PushPinIcon size={20} />
							</ActionIcon>
						</Tooltip>
					)}
					{canEdit && !selectable && (
						<Menu position="bottom-end" withinPortal>
							<Menu.Target>
								<ActionIcon
									variant="subtle"
									color="gray"
									aria-label={t`Project options`}
									// The row is a link; the menu must not follow it.
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
									}}
									{...testId(`project-list-item-menu-${project.id}`)}
								>
									<DotsThreeIcon size={20} />
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown
								// The dropdown is portalled but React events still bubble
								// to the row link; keep them from navigating.
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
								}}
							>
								<Menu.Item
									onClick={() => renameHandlers.open()}
									{...testId(`project-list-item-rename-${project.id}`)}
								>
									<Trans>Rename project</Trans>
								</Menu.Item>
								<Menu.Item
									onClick={() =>
										navigate(
											`/w/${workspaceId}/projects/${project.id}/portal-editor`,
										)
									}
									{...testId(`project-list-item-portal-${project.id}`)}
								>
									<Trans>Configure portal</Trans>
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					)}
				</Group>
			</Flex>
		</Group>
	);

	// A link-rendered Paper gets the full box from rules.css; in select mode
	// the row is a checkbox and takes the same box via app-do.
	const body = selectable ? (
		<Paper
			component="div"
			p="sm"
			className="app-do group relative"
			data-selected={selected || undefined}
			aria-checked={selected}
			aria-label={project.name ?? t`Select project`}
			onClick={onToggleSelect}
			onKeyDown={(e) => {
				if (e.key === " " || e.key === "Enter") {
					e.preventDefault();
					onToggleSelect?.();
				}
			}}
			role="checkbox"
			tabIndex={0}
			{...testId(`project-list-item-${project.id}`)}
		>
			{content}
		</Paper>
	) : (
		<Paper
			component={I18nLink}
			to={link}
			p="sm"
			className="group relative"
			{...testId(`project-list-item-${project.id}`)}
		>
			{content}
		</Paper>
	);

	// In select mode the card is the toggle target, so it must not navigate.
	if (selectable) return body;
	return (
		<>
			{body}
			{/* Outside the link, so typing and clicking in it never navigate. */}
			{canEdit && (
				<InputModal
					opened={renameOpened}
					onClose={renameHandlers.close}
					title={t`Rename project`}
					label={<Trans>Project name</Trans>}
					initialValue={project.name ?? ""}
					loading={updateProject.isPending}
					onConfirm={(name) => {
						if (name === project.name) {
							renameHandlers.close();
							return;
						}
						updateProject.mutate(
							{ id: project.id, payload: { name } },
							{
								onSuccess: () => {
									queryClient.invalidateQueries({
										queryKey: ["v2", "workspace-projects"],
									});
									renameHandlers.close();
								},
							},
						);
					}}
					data-testid="project-rename-modal"
				/>
			)}
		</>
	);
};
