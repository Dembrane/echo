import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Checkbox,
	Group,
	Paper,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { IconLock, IconSearch, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";

const SEARCH_THRESHOLD = 7; // show search input only when scanning is slow

export interface InviteableWorkspace {
	id: string;
	name: string;
	tier: string;
	is_private?: boolean;
	member_count: number;
	// Includes pending invite rows; the preview adds pendingCount on top (backend dedups at submit).
	seats_used_including_pending: number;
	seat_cap: number | null;
	seat_invite_blocked: boolean;
}

interface Props {
	workspaces: InviteableWorkspace[];
	selected: Set<string>;
	onToggle: (workspaceId: string) => void;
	// Number of pending email entries; used to disable rows whose cap would be exceeded.
	pendingCount: number;
	loading?: boolean;
	"data-testid"?: string;
}

// Workspace picker with per-row seat usage. Hard-block tiers disable via backend `seat_invite_blocked`; soft-cap tiers show overage as a warning.
export function WorkspaceSelectList({
	workspaces,
	selected,
	onToggle,
	pendingCount,
	loading,
	"data-testid": dataTestId,
}: Props) {
	const [search, setSearch] = useState("");
	const showSearch = workspaces.length > SEARCH_THRESHOLD;

	const visibleWorkspaces = useMemo(() => {
		if (!showSearch || !search.trim()) return workspaces;
		const needle = search.trim().toLowerCase();
		return workspaces.filter((w) => w.name.toLowerCase().includes(needle));
	}, [workspaces, search, showSearch]);

	if (loading) {
		return (
			<Text size="sm" c="dimmed">
				<Trans>Loading workspaces…</Trans>
			</Text>
		);
	}

	if (workspaces.length === 0) {
		return (
			<Alert color="gray" variant="light">
				<Trans>
					You don't have permission to invite to any workspace in this
					organisation.
				</Trans>
			</Alert>
		);
	}

	return (
		<Stack gap={6} data-testid={dataTestId}>
			{showSearch && (
				<TextInput
					value={search}
					onChange={(e) => setSearch(e.currentTarget.value)}
					placeholder={t`Search workspaces`}
					leftSection={<IconSearch size={14} />}
					rightSection={
						search ? (
							<ActionIcon
								variant="subtle"
								color="gray"
								size="xs"
								onClick={() => setSearch("")}
								aria-label={t`Clear search`}
							>
								<IconX size={12} />
							</ActionIcon>
						) : null
					}
					rightSectionPointerEvents="all"
					size="xs"
					data-testid={dataTestId ? `${dataTestId}-search` : undefined}
				/>
			)}
			<ScrollArea.Autosize mah={300} type="auto" offsetScrollbars>
				<Stack gap={6} pr={4}>
					{showSearch && visibleWorkspaces.length === 0 && (
						<Text size="xs" c="dimmed" ta="center" py="xs">
							<Trans>No workspaces match "{search}".</Trans>
						</Text>
					)}
					{visibleWorkspaces.map((ws) => {
						const isSelected = selected.has(ws.id);
						// Only `seat_invite_blocked` hard-disables; allow deselect so a preselected row that flipped blocked isn't stuck.
						const blocked = ws.seat_invite_blocked;
						const interactionDisabled = blocked && !isSelected;
						const overage =
							!blocked &&
							ws.seat_cap != null &&
							ws.seats_used_including_pending + pendingCount > ws.seat_cap;

						const capLabel =
							ws.seat_cap == null ? (
								<Trans>{ws.seats_used_including_pending} seats</Trans>
							) : (
								<>
									{ws.seats_used_including_pending}/{ws.seat_cap}{" "}
									<Trans>seats</Trans>
								</>
							);

						const row = (
							<Paper
								key={ws.id}
								withBorder
								p="sm"
								radius="sm"
								onClick={() => !interactionDisabled && onToggle(ws.id)}
								style={{
									backgroundColor: isSelected
										? "var(--mantine-primary-color-light)"
										: undefined,
									borderColor: isSelected
										? "var(--mantine-primary-color-filled)"
										: undefined,
									cursor: interactionDisabled ? "not-allowed" : "pointer",
									opacity: blocked ? 0.55 : 1,
								}}
							>
								<Group justify="space-between" wrap="nowrap">
									<Group gap={12} wrap="nowrap" style={{ minWidth: 0 }}>
										<Checkbox
											checked={isSelected}
											disabled={interactionDisabled}
											onChange={() => onToggle(ws.id)}
											onClick={(e) => e.stopPropagation()}
											aria-label={t`Select ${ws.name}`}
										/>
										<Box style={{ minWidth: 0 }}>
											<Group gap={6} wrap="nowrap">
												<Text size="sm" fw={500} lineClamp={1}>
													{ws.name}
												</Text>
												{ws.is_private && (
													<IconLock
														size={12}
														style={{ color: "var(--mantine-color-gray-6)" }}
													/>
												)}
											</Group>
											<Group gap={6} wrap="nowrap" mt={2}>
												<Badge size="xs" variant="light" color="gray">
													<span style={{ textTransform: "capitalize" }}>
														{ws.tier}
													</span>
												</Badge>
												<Text size="xs" c="dimmed">
													{capLabel}
												</Text>
											</Group>
											{overage && (
												<Text size="xs" c="orange" mt={4}>
													<Trans>
														Exceeds seat cap. Overage billing applies.
													</Trans>
												</Text>
											)}
										</Box>
									</Group>
									{blocked ? (
										<Badge size="xs" variant="light" color="yellow">
											<Trans>Seats full</Trans>
										</Badge>
									) : overage ? (
										<Badge size="xs" variant="light" color="orange">
											<Trans>Overage billing applies</Trans>
										</Badge>
									) : null}
								</Group>
							</Paper>
						);

						if (blocked) {
							return (
								<Tooltip
									key={ws.id}
									label={t`This workspace is on a tier that doesn't allow more seats. Upgrade the workspace tier to invite more.`}
									withArrow
									multiline
									w={300}
									position="top"
									events={{ focus: true, hover: true, touch: true }}
								>
									<Box>{row}</Box>
								</Tooltip>
							);
						}
						if (overage && isSelected && pendingCount > 0) {
							return (
								<Tooltip
									key={ws.id}
									label={t`Adding ${pendingCount} more will put this workspace over its seat cap. Overage seats are billed at the workspace's tier rate.`}
									withArrow
									multiline
									w={300}
									position="top"
									events={{ focus: true, hover: true, touch: true }}
								>
									<Box>{row}</Box>
								</Tooltip>
							);
						}
						return <Box key={ws.id}>{row}</Box>;
					})}
				</Stack>
			</ScrollArea.Autosize>
		</Stack>
	);
}
